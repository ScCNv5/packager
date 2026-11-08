import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vmModule from 'node:vm';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {stepMethods, hatsBody, linkPlayer} from '../src/specialized/link.mjs';
import {rollup} from 'rollup';
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const Thread = require('./src/engine/thread');
const {lower} = require('./src/compiler/continuation');
const Storage = require('scratch-storage');
const sourcePack = JSON.parse(await fs.readFile(new URL('../generated/runtime-sources.json', import.meta.url)));
const helpers = await import(`data:text/javascript;base64,${Buffer.from(sourcePack.helpers).toString('base64')}`);

// This harness evaluates generated methods only in the test process. Production
// inserts their AST into Sequencer before linking and never loads generated code.
export function installForTest(vm, program) {
  vm.runtime.targets.forEach((target, index) => { target.sprite.__spTarget = index; });
  const context = vmModule.createContext({...helpers, Thread, console, Math, Date,
    Timer: require('./src/util/timer'), Cast: require('./src/util/cast'),
    log: require('./src/util/log'), execute: require('./src/engine/execute'),
    SpecializedBlockUtility: require('./src/compiler/specialized-block-utility')});
  for (const [name, body] of Object.entries(stepMethods(program.blocks))) {
    vm.runtime.sequencer[name] = new vmModule.Script(`(function(thread) ${body})`).runInContext(context);
  }
  vm.runtime.startHats = new vmModule.Script(`(function(opcode,fields,target) ${hatsBody(program.hats)})`).runInContext(context);
  vm.runtime.__spPrimitive = (opcode, args, util) => vm.runtime.getOpcodeFunction(opcode)(args, util);
  const initialize = thread => {
    thread.isCompiled = true; thread.triedToCompile = true; thread.__spLifetime = {};
    thread.__spFrames = [{__spPC: Number(thread.topBlock), __spSlots: [], __spArgs: [], __spReturn: -1}];
    return thread;
  };
  for (const name of ['_pushThread', '_restartThread']) {
    const previous = vm.runtime[name];
    vm.runtime[name] = function (...args) {
      this.compilerOptions.enabled = false;
      if (name === '_restartThread') args[0].__spLifetime = null;
      const thread = previous.apply(this, args);
      this.compilerOptions.enabled = true;
      if (!thread.updateMonitor) initialize(thread);
      if (name === '_restartThread') thread.executableHat = args[0].executableHat;
      return thread;
    };
  }
  const retire = vm.runtime.sequencer.retireThread;
  vm.runtime.sequencer.retireThread = function (thread) {
    thread.__spLifetime = null; thread.__spFrames = []; return retire.call(this, thread);
  };
}

const directory = new URL('../../scratch-vm/test/fixtures/execute/', import.meta.url);
const linked = process.argv.includes('--linked');
const aggressiveRenaming = process.argv.includes('--aggressive');
const filter = process.argv.slice(2).find(value => !value.startsWith('--'));
const shard = process.argv.find(value => value.startsWith('--shard='))?.slice(8) || '0/1';
const [shardIndex, shardCount] = shard.split('/').map(Number);
assert(Number.isInteger(shardIndex) && Number.isInteger(shardCount) && shardCount > 0 &&
  shardIndex >= 0 && shardIndex < shardCount, 'Expected --shard=index/count with a zero-based index');
const names = process.argv[1] === fileURLToPath(import.meta.url) ? (await fs.readdir(directory))
  .filter(name => /\.sb[23]?$/.test(name) && (!filter || name.includes(filter))).sort()
  .filter((name, index) => index % shardCount === shardIndex) : [];
let failures = 0;
for (const name of names) {
  const data = await fs.readFile(new URL(name, directory));
  const run = async specialized => {
    let vm = new VM(); vm.attachStorage(new Storage()); vm.setCompilerOptions({enabled: true});
    let properties = {};
    const read = (object, name) => object[properties[name] || name];
    const call = (object, name, ...args) => read(object, name).apply(object, args);
    const originalRandom = Math.random;
    const RealDate = Date;
    const events = [];
    const descriptors = {};
    try {
      await vm.loadProject(data);
      if (specialized && linked) {
        const input = vm.exportSpecializedProjectBuildInput();
        const built = await linkPlayer({sourcePack, input, program: lower(input, 42), seed: 'linked-differential',
          aggressiveRenaming, boot: `const vm = new Scaffolding.VM(); globalThis.linkedDifferentialVM = vm;
            vm.setCompilerOptions({enabled: true});
            globalThis.linkedDifferentialReady = vm.loadProject(${JSON.stringify(JSON.stringify(input.project))});`}, rollup);
        const element = () => ({style: {}, appendChild() {}, insertBefore() {}, setAttribute() {}, getContext() { return null; }});
        const globals = {window: globalThis, self: globalThis,
          document: {hidden: false, createElement: element, head: element(), body: element()}};
        for (const key of Object.keys(globals)) descriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.assign(globalThis, globals);
        vm.quit();
        new vmModule.Script(built.code).runInThisContext();
        vm = globalThis.linkedDifferentialVM;
        properties = built.diagnostics.propertyMap;
        await globalThis.linkedDifferentialReady;
      }
      vm.runtime.on('SAY', (target, kind, value) => events.push([target.getName(), kind, String(value)]));
      let logicalTime = RealDate.UTC(2024, 0, 1);
      global.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [logicalTime])); }
        static now() { return Math.floor(logicalTime); }
      };
      if (specialized && !linked) installForTest(vm, lower(vm.exportSpecializedProjectBuildInput(), 42));
      let random = 1234;
      Math.random = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296; };
      call(vm, 'greenFlag');
      const deadline = RealDate.now() + 10000;
      for (let tick = 0; tick < 20000; tick++) {
        call(vm.runtime, '_step');
        logicalTime += 1000 / 30;
        if (!read(vm.runtime, 'threads').some(t => !t.updateMonitor) || events.some(e => e[2] === 'end')) break;
        if (RealDate.now() > deadline) throw new Error('Fixture timed out');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      return {events, values: vm.runtime.targets.map(target => [target.getName(),
        Object.values(target.variables).map(variable => [variable.name, variable.type, variable.value])])};
    } finally {
      call(vm, 'quit'); Math.random = originalRandom; global.Date = RealDate;
      delete globalThis.linkedDifferentialVM; delete globalThis.linkedDifferentialReady;
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
      }
    }
  };
  try {
    const baseline = await run(false);
    const specialized = await run(true);
    // Preserve NaN, infinities and negative zero; JSON comparison conflates them.
    assert.deepEqual(structuredClone(specialized), structuredClone(baseline), 'Semantic mismatch');
    console.log(`PASS ${name}`);
  } catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`); }
}
if (names.length) {
  console.log(`${names.length - failures}/${names.length} fixtures passed`);
  process.exitCode = failures ? 1 : 0;
}
