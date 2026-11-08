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
import {rewriteThreadStatus, threadStatusProperty} from '../src/specialized/aggressive-properties.mjs';
import {targetFields, targetProperty, targetStateModule, targetStateSource, rewriteTargetState, finalizeTargetState} from '../src/specialized/target-state.mjs';

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
const transform = (source, seed = 'properties', aggressiveProperties = []) => {
  const tree = parse(source), diagnostics = {};
  renameProperties(tree, seed, diagnostics, [], aggressiveProperties);
  return {code: generate(tree).code, diagnostics};
};
const execute = code => new vm.Script(code).runInNewContext();

test('private target state preserves JSON, native size, receiver evaluation, calls and optional access', async () => {
  const tree = parse(`class Base {}
    class Target extends Base {
      constructor(data) { super(); this.size = data.size; this.visible = data.visible;
        this.variables = data.variables; this.runtime = function () { return this; }; }
      toJSON() { return {size: this.size, visible: this.visible, variables: this.variables}; }
    }
    const data = {size: 30, visible: true, variables: {answer: 7}};
    const target = new Target(data);
    let calls = 0; const get = () => { calls++; return target; };
    get().size += 5;
    const {visible} = target;
    const missing = null;
    globalThis.stateResult = [target.toJSON(), data.size, new Map([[1, 2]]).size,
      calls, visible, target.runtime() === target, missing?.size, target?.size,
      Object.keys(target).includes('size'), Object.hasOwn(target, 'size'),
      Object.prototype.hasOwnProperty.call(target, 'size'), 'size' in target,
      Reflect.get(target, 'size')];`, {sourceType: 'module'});
  const counts = rewriteTargetState(tree, 'scratch-vm/src/engine/target.js');
  assert(counts.direct > 0 && counts.accesses > counts.direct);
  const bundle = await rollup({input: 'entry', plugins: [{name: 'state-test',
    resolveId(id) { return id; }, load(id) { return id === targetStateModule ? targetStateSource : generate(tree).code; }}]});
  try {
    const generated = (await bundle.generate({format: 'iife'})).output[0].code;
    const linked = parse(generated);
    const diagnostics = {};
    renameProperties(linked, 'state-test', diagnostics, [], targetFields.map(targetProperty));
    finalizeTargetState(linked, diagnostics.propertyMap);
    const result = new vm.Script(generate(linked).code + '\nstateResult;').runInNewContext();
    assert.deepEqual(JSON.parse(JSON.stringify(result)), [
      {size: 35, visible: true, variables: {answer: 7}}, 30, 1, 1, true, true, null, 35, false, true, true, true, 35]);
  } finally { await bundle.close(); }
});

test('scoped thread status is renamed without changing HTTP response status', () => {
  const tree = parse(`class Thread { constructor() { this.status = 0; } }
    const thread = new Thread(); thread['status'] = 4; thread.status;`);
  assert.equal(rewriteThreadStatus(tree, 'scratch-vm/src/engine/thread.js'), 3);
  const diagnostics = {};
  renameProperties(tree, 'status', diagnostics, [], [threadStatusProperty]);
  const code = generate(tree).code;
  assert.equal(execute(code), 4);
  assert(!code.includes('.status') && !code.includes(threadStatusProperty));
  const external = parse('const response = {status: 200}; response.status;');
  assert.equal(rewriteThreadStatus(external, 'scratch-vm/src/extension-support/tw-external.js'), 0);
  assert.equal(execute(generate(external).code), 200);
  assert.throws(() => rewriteThreadStatus(parse('response.status;'), 'scratch-vm/src/engine/runtime.js'), /Unreviewed thread status receiver/);
});

test('aggressive candidates share a seeded map and retain literal reflection boundaries', () => {
  const source = `class Motion { _moveSteps(n, target) { target.x += n; } }
    const runtime = {ext_scratch3_motion: new Motion()}, target = {x: 0};
    runtime.ext_scratch3_motion._moveSteps(10, target); target.x;`;
  const names = ['ext_scratch3_motion', '_moveSteps'];
  assert(names.every(name => !transform(source).diagnostics.propertyMap[name]));
  const result = transform(source, 'aggressive', names);
  assert.equal(execute(result.code), 10);
  assert(names.every(name => result.diagnostics.propertyMap[name] && !result.code.includes(name)));
  assert.equal(result.code, transform(source, 'aggressive', names).code);
  assert.notEqual(result.code, transform(source, 'other', names).code);
  const reflected = transform(source + `runtime.ext_scratch3_motion['_moveSteps'](5, target); target.x;`, 'aggressive', names);
  assert.equal(execute(reflected.code), 15);
  assert(!reflected.diagnostics.propertyMap._moveSteps);
  assert(reflected.diagnostics.propertyMap.ext_scratch3_motion);
});

test('aggressive core package renaming preserves motion, clones and restart', async () => {
  const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
  const VM = require('./src/virtual-machine'), {lower} = require('./src/compiler/continuation');
  const original = new VM();
  const project = fixtureProject();
  const stage = project.targets[0];
  stage.blocks = {}; stage.costumes = []; project.monitors = [];
  const sprite = {...structuredClone(stage), isStage: false, name: 'Sprite', variables: {},
    visible: true, x: 0, y: 0, direction: 90, size: 100, rotationStyle: 'all around', layerOrder: 1};
  const block = (opcode, parent, next, inputs = {}, fields = {}) =>
    ({opcode, parent, next, inputs, fields, shadow: false, topLevel: !parent});
  sprite.blocks = {
    flag: block('event_whenflagclicked', null, 'reset'),
    reset: block('motion_gotoxy', 'flag', 'move', {X: [1, [4, '0']], Y: [1, [4, '0']]}),
    move: block('motion_movesteps', 'reset', 'clone', {STEPS: [1, [4, '10']]}),
    clone: block('control_create_clone_of', 'move', null, {CLONE_OPTION: [1, [10, '_myself_']]}),
    cloneHat: block('control_start_as_clone', null, 'cloneMove'),
    cloneMove: block('motion_movesteps', 'cloneHat', 'record', {STEPS: [1, [4, '5']]}),
    record: block('data_setvariableto', 'cloneMove', null,
      {VALUE: [3, 'x', [4, '0']]}, {VARIABLE: ['answer', 'answer']}),
    x: block('motion_xposition', 'record', null)
  };
  project.targets.push(sprite);
  const sourcePack = JSON.parse(await fs.readFile(new URL('../generated/runtime-sources.json', import.meta.url)));
  const descriptors = {};
  const element = () => ({style: {}, appendChild() {}, insertBefore() {}, setAttribute() {}, getContext() { return null; }});
  let playerVM;
  let properties = {};
  let scoped = {};
  const state = (object, name) => object[scoped[`Target.${name}`] || name];
  const call = (object, name, ...args) => object[properties[name] || name](...args);
  try {
    await original.loadProject(JSON.stringify(project));
    const input = original.exportSpecializedProjectBuildInput();
    for (const [name, value] of Object.entries({window: globalThis, self: globalThis,
      document: {hidden: false, createElement: element, head: element(), body: element()}})) {
      descriptors[name] = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, {value, configurable: true, writable: true});
    }
    for (const aggressiveRenaming of [false, true]) {
      const result = await linkPlayer({sourcePack, input, program: lower(input, 42), seed: 'aggressive-core',
        aggressiveRenaming, boot: `const vm = new Scaffolding.VM(); globalThis.aggressiveVM = vm;
          globalThis.aggressiveReady = vm.loadProject(${JSON.stringify(JSON.stringify(input.project))});`}, rollup);
      for (const name of ['ext_scratch3_motion', '_moveSteps', 'ext_scratch3_control', '_createClone']) {
        assert.equal(Boolean(result.diagnostics.propertyMap[name]), aggressiveRenaming, name);
        if (aggressiveRenaming) assert(!result.code.includes(name), `${name} should not survive in player code`);
      }
      assert.equal(result.diagnostics.aggressiveRenaming, aggressiveRenaming);
      for (const name of ['isKilled', 'setXY', 'getTargetForStage', 'startHats']) {
        assert.equal(Boolean(result.diagnostics.propertyMap[name]), aggressiveRenaming, name);
        if (aggressiveRenaming) assert(!result.code.includes(`.${name}`), name);
      }
      if (aggressiveRenaming) {
        assert(result.diagnostics.scopedProperties['Thread.status']);
        assert(result.diagnostics.reservedPropertyReasons.currentCostume.length);
        assert(!result.diagnostics.propertyMap.variables && !result.diagnostics.propertyMap.value);
      }
      new vm.Script(result.code).runInThisContext();
      await globalThis.aggressiveReady; playerVM = globalThis.aggressiveVM;
      properties = result.diagnostics.propertyMap;
      scoped = result.diagnostics.scopedProperties || {};
      for (let run = 0; run < 2; run++) {
        call(playerVM, 'greenFlag');
        for (let tick = 0; tick < 10; tick++) call(playerVM.runtime, '_step');
        assert.equal(state(call(playerVM.runtime, 'getTargetForStage'), 'variables').answer.value, 15);
        assert.deepEqual(playerVM.runtime.targets.filter(target => !state(target, 'isStage')).map(target => state(target, 'x')), [10, 15]);
        call(playerVM, 'stopAll');
      }
      call(playerVM, 'quit'); playerVM = null;
    }
  } finally {
    original.quit(); if (playerVM) call(playerVM, 'quit');
    delete globalThis.aggressiveVM; delete globalThis.aggressiveReady;
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});

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

for (const aggressiveRenaming of [false, true]) test(`the linked pause addon shares VM properties (aggressive=${aggressiveRenaming})`, async () => {
  const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
  const VM = require('./src/virtual-machine'), {lower} = require('./src/compiler/continuation');
  const original = new VM();
  let playerVM;
  let properties = {};
  let scoped = {};
  const state = (object, name) => object[scoped[`Target.${name}`] || name];
  const read = (object, name) => object[properties[name] || name];
  const call = (object, name, ...args) => read(object, name).apply(object, args);
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
      aggressiveRenaming, addons: {pause: true}, boot: `const vm = new Scaffolding.VM();
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
    properties = result.diagnostics.propertyMap;
    scoped = result.diagnostics.scopedProperties || {};
    const key = result.diagnostics.propertyMap.stepThreads;
    const sequencer = read(playerVM.runtime, 'sequencer');
    assert(key && typeof sequencer[key] === 'function');
    assert.equal(sequencer.stepThreads, undefined);
    assert.notEqual(sequencer[key], Object.getPrototypeOf(sequencer)[key], 'pause hook overrides the renamed method');
    const value = () => state(call(playerVM.runtime, 'getTargetForStage'), 'variables').answer.value;
    call(playerVM, 'greenFlag'); call(playerVM.runtime, '_step');
    const before = value();
    assert(before > 0 && before < 100000);
    playerVM.setPaused(true);
    for (let tick = 0; tick < 4; tick++) call(playerVM.runtime, '_step');
    assert.equal(value(), before);
    playerVM.setPaused(false); call(playerVM.runtime, '_step');
    assert(value() > before);
    call(playerVM, 'stopAll'); call(playerVM, 'greenFlag'); call(playerVM.runtime, '_step');
    assert(value() > 0 && value() < 100000);
  } finally {
    original.quit(); if (playerVM) call(playerVM, 'quit');
    delete globalThis.renamedVM; delete globalThis.renamedReady;
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  }
});
