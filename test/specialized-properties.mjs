import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {rollup} from 'rollup';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import generateModule from '@babel/generator';
import {renameProperties, linkPlayer} from '../src/specialized/link.mjs';
import {fixtureProject} from './specialized-fixtures.mjs';

const generate = generateModule.default || generateModule;
const definitions = `
  class A {
    static __spOwnerThread() {}
    static getIdFromTargetAndBlock() { return 13; }
    constructor() { this.value = 7; this.status = 0; }
    peekStack() { return this.value; }
  }
  class B {
    static __spOwnerSequencer() {}
    stepThread(t) { const {peekStack: read} = t; return read.call(t); }
    stepThreads(t) { return this.stepThread(t); }
    retireThread(t) { t.status = 4; }
  }
  const runtime = {sequencer: new B()};
  const task = new A();
`;
const transform = (source, seed = 'properties') => {
  const tree = parse(source), diagnostics = {};
  renameProperties(tree, seed, diagnostics);
  return {code: generate(tree).code, diagnostics};
};
const execute = code => new vm.Script(code).runInNewContext();

test('VM declarations, aliases, destructuring and optional calls share one property map', () => {
  const source = definitions + `
    const scheduler = runtime.sequencer;
    const answer = scheduler?.stepThread(task);
    scheduler.retireThread(task);
    [answer, task.status, task.value].join(',');
  `;
  const {code, diagnostics} = transform(source);
  assert.equal(execute(code), '7,4,7');
  for (const name of ['stepThread', 'stepThreads', 'retireThread', 'peekStack']) {
    assert(diagnostics.propertyMap[name], `${name} must be renamed`);
  }
  assert(!code.includes('__spOwner'));
  assert(code.includes('.status') && code.includes('.value'), 'protocol-shaped fields stay stable');
  assert.equal(code, transform(source).code);
  const other = transform(source, 'another-seed');
  assert.notEqual(code, other.code);
  assert.equal(execute(other.code), '7,4,7');
});

test('literal computed accesses reserve their property and explain why', () => {
  const {code, diagnostics} = transform(definitions + `task?.['peekStack']();`);
  assert.equal(execute(code), 7);
  assert(!diagnostics.propertyMap.peekStack);
  assert(diagnostics.propertyMap.stepThread);
  assert(diagnostics.reservedPropertyReasons.peekStack.includes('computed string access'));
});

test('WeakMap thread state operations are not treated as reflective property access', () => {
  const {code, diagnostics} = transform(definitions + `
    const states = new WeakMap(); states.set(task, 9);
    [states.get(task), task.peekStack()].join(',');
  `);
  assert.equal(execute(code), '9,7');
  assert(diagnostics.propertyMap.peekStack);
});

test('static Thread methods use declaration identity instead of a class name', () => {
  const {code, diagnostics} = transform(definitions + `A.getIdFromTargetAndBlock();`);
  assert.equal(execute(code), 13);
  assert(diagnostics.propertyMap.getIdFromTargetAndBlock);
});

test('Rollup class expressions and constructor aliases preserve the ownership annotation', () => {
  const {code, diagnostics} = transform(`
    const Original = class LinkedClass {
      static __spOwnerThread() {}
      static getIdFromTargetAndBlock() { return 5; }
      pushStack() { return LinkedClass.getIdFromTargetAndBlock() + 3; }
    };
    const Alias = Original;
    const task = new Alias();
    [Alias.getIdFromTargetAndBlock(), task.pushStack()].join(',');
  `);
  assert.equal(execute(code), '5,8');
  assert(diagnostics.propertyMap.getIdFromTargetAndBlock && diagnostics.propertyMap.pushStack);
});

test('dynamic access through a scheduler alias preserves the whole family', () => {
  const {code, diagnostics} = transform(definitions + `
    const alias = runtime.sequencer;
    const name = ['step', 'Thread'].join('');
    alias[name](task);
  `);
  assert.equal(execute(code), 7);
  for (const entry of diagnostics.schedulingProperties.Sequencer) {
    assert.equal(entry.renamed, null);
    assert(entry.reasons.includes('dynamic access to an internal scheduling object'));
  }
});

test('dynamic reflection and prototype enumeration preserve observable method names', () => {
  for (const expression of [
    `Reflect.get(task, ['peek', 'Stack'].join('')).call(task)`,
    `Reflect?.get(task, ['peek', 'Stack'].join('')).call(task)`,
    `['peek', 'Stack'].join('') in task`,
    `Reflect.ownKeys(Object.getPrototypeOf(task)).includes(['peek', 'Stack'].join(''))`
  ]) {
    const {code, diagnostics} = transform(definitions + expression);
    assert.equal(execute(code), execute(definitions + expression));
    assert(!diagnostics.propertyMap.peekStack);
    assert(diagnostics.reservedPropertyReasons.peekStack.length);
  }
});

test('reflected own methods remain visible after an addon replaces a scheduling hook', () => {
  for (const reflection of [
    `Object.hasOwn(alias, key)`,
    `alias.hasOwnProperty(key)`,
    `Object.prototype.hasOwnProperty.call(alias, key)`
  ]) {
    const {code, diagnostics} = transform(definitions + `
      const alias = runtime.sequencer;
      alias.stepThreads = () => 23;
      const key = ['step', 'Threads'].join('');
      ${reflection};
    `);
    assert.equal(execute(code), true);
    assert(!diagnostics.propertyMap.stepThreads);
  }
});

test('unknown receivers and unrelated definitions do not inherit scheduling ownership', () => {
  for (const extra of [
    `function read(thread) { return thread.peekStack(); } read(task);`,
    `const external = {peekStack() { return 9; }}; external.peekStack();`,
    `class Thread { peekStack() { return 11; } } new Thread().peekStack();`
  ]) {
    const {code, diagnostics} = transform(definitions + extra);
    assert.equal(execute(code), execute(definitions + extra));
    assert(!diagnostics.propertyMap.peekStack);
    assert(diagnostics.reservedPropertyReasons.peekStack.length);
  }
});

test('reassigned aliases preserve unknown receivers and dynamic scheduling accesses', () => {
  for (const extra of [
    `let alias = runtime.sequencer; alias = JSON.parse('{"stepThread":19}'); alias.stepThread;`,
    `let alias; alias = runtime.sequencer; alias[['step', 'Thread'].join('')](task);`
  ]) {
    const {code, diagnostics} = transform(definitions + extra);
    assert.equal(execute(code), execute(definitions + extra));
    assert(!diagnostics.propertyMap.stepThread);
    assert(diagnostics.reservedPropertyReasons.stepThread.length);
  }
});

test('the linked pause addon uses the same scheduling names as the VM and program', async () => {
  const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
  const VM = require('./src/virtual-machine'), {lower} = require('./src/compiler/continuation');
  const original = new VM();
  let playerVM;
  const descriptors = {};
  try {
    const project = fixtureProject({iterations: 100000});
    project.monitors = []; project.targets[0].costumes = [];
    project.targets[0].blocks.change.next = 'wait';
    project.targets[0].blocks.wait = {opcode: 'control_wait', parent: 'change', next: null,
      topLevel: false, shadow: false, fields: {}, inputs: {DURATION: [1, [4, '0']]}};
    await original.loadProject(JSON.stringify(project));
    const input = original.exportSpecializedProjectBuildInput();
    const sourcePack = JSON.parse(await fs.readFile(new URL('../generated/runtime-sources.json', import.meta.url)));
    const threadId = Object.keys(sourcePack.sources).find(id => id.endsWith('scratch-vm/src/engine/thread.js'));
    const changed = parse(sourcePack.sources[threadId], {sourceType: 'module'});
    const cls = changed.program.body.find(node => t.isClassDeclaration(node) && node.id.name === 'Thread');
    cls.body.body.find(method => method.key.name === 'pushStack').params.push(t.identifier('unexpected'));
    await assert.rejects(linkPlayer({sourcePack: {...sourcePack,
      sources: {...sourcePack.sources, [threadId]: generate(changed).code}}, input,
      program: lower(input, 42), seed: 'changed-signature', boot: ''}, () => {
      throw new Error('Must reject changed ownership contracts before linking');
    }), /Thread methods changed/);
    const result = await linkPlayer({sourcePack, input, program: lower(input, 42), seed: 'pause-property-audit',
      addons: {pause: true}, boot: `const vm = new Scaffolding.VM();
        ScaffoldingAddons.run({vm}, {pause: true});
        globalThis.renamedVM = vm;
        globalThis.renamedReady = vm.loadProject(${JSON.stringify(JSON.stringify(input.project))});`}, rollup);
    const element = () => ({style: {}, appendChild() {}, insertBefore() {}, setAttribute() {}, getContext() { return null; }});
    for (const [name, value] of Object.entries({window: globalThis, self: globalThis,
      document: {hidden: false, createElement: element, head: element(), body: element()}})) {
      descriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    }
    new vm.Script(result.code).runInThisContext();
    await globalThis.renamedReady; playerVM = globalThis.renamedVM;
    const key = result.diagnostics.propertyMap.stepThreads;
    const sequencer = playerVM.runtime.sequencer;
    assert(key && typeof sequencer[key] === 'function');
    assert.equal(sequencer.stepThreads, undefined);
    assert.notEqual(sequencer[key], Object.getPrototypeOf(sequencer)[key], 'pause hook overrides the renamed method');
    const value = () => playerVM.runtime.getTargetForStage().variables.answer.value;
    playerVM.greenFlag(); playerVM.runtime._step();
    const before = value();
    assert(before > 0 && before < 100000);
    playerVM.setPaused(true);
    for (let tick = 0; tick < 4; tick++) playerVM.runtime._step();
    assert.equal(value(), before);
    playerVM.setPaused(false); playerVM.runtime._step();
    assert(value() > before);
    playerVM.stopAll(); playerVM.greenFlag(); playerVM.runtime._step();
    assert(value() > 0 && value() < 100000);
  } finally {
    original.quit(); playerVM?.quit();
    delete globalThis.renamedVM; delete globalThis.renamedReady;
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
