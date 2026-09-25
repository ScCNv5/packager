import fs from 'node:fs/promises';
import vmModule from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {linkPlayer} from '../src/specialized/link.mjs';
import {rollup} from 'rollup';
import {fixtureProject} from './specialized-fixtures.mjs';
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const {lower} = require('./src/compiler/continuation');
const sourcePack = JSON.parse(await fs.readFile(new URL('../generated/runtime-sources.json', import.meta.url)));
const quiet = {log() {}, warn() {}, error() {}, debug() {}, info() {}};
const element = () => ({style: {}, appendChild() {}, insertBefore() {}, setAttribute() {}, getContext() { return null; }});
const report = [];

for (const category of ['compute', 'warp-calls', 'list', 'broadcast', 'clone', 'pen']) {
  const project = fixtureProject({iterations: category === 'compute' || category === 'list' ? 200000 : 10000});
  project.monitors = [];
  project.targets[0].costumes = [];
  delete project.targets[0].blocks.say;
  project.targets[0].blocks.repeat.next = null;
  const target = project.targets[0];
  if (category === 'warp-calls') {
    const blocks = target.blocks;
    blocks.set.next = 'call';
    blocks.repeat.parent = 'definition';
    blocks.repeat.inputs.TIMES = [1, [4, '1000000']];
    blocks.repeat.inputs.SUBSTACK = [2, 'innerCall'];
    blocks.change.parent = 'innerDefinition';
    const mutation = code => ({tagName: 'mutation', children: [], proccode: code,
      argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'true'});
    const block = (opcode, parent, next, inputs = {}) => ({opcode, parent, next, inputs, fields: {}, topLevel: !parent});
    blocks.call = {...block('procedures_call', 'set', null), mutation: mutation('work')};
    blocks.definition = block('procedures_definition', null, 'repeat', {custom_block: [1, 'prototype']});
    blocks.prototype = {...block('procedures_prototype', 'definition', null), shadow: true, mutation: mutation('work')};
    blocks.innerCall = {...block('procedures_call', 'repeat', null), mutation: mutation('step')};
    blocks.innerDefinition = block('procedures_definition', null, 'change', {custom_block: [1, 'innerPrototype']});
    blocks.innerPrototype = {...block('procedures_prototype', 'innerDefinition', null), shadow: true, mutation: mutation('step')};
    // Cold scripts expose oversized-dispatcher regressions that a lone loop misses.
    for (let i = 0; i < 80; i++) blocks[`cold${i}`] = block('event_whenkeypressed', null, null);
    for (let i = 0; i < 80; i++) blocks[`cold${i}`].fields.KEY_OPTION = ['space', null];
  }
  if (category === 'list') {
    target.lists.items = ['items', []];
    target.blocks.change.opcode = 'data_addtolist';
    target.blocks.change.fields = {LIST: ['items', 'items']};
    target.blocks.change.inputs = {ITEM: [1, [4, '1']]};
  }
  if (category === 'broadcast') {
    target.broadcasts.message = 'message';
    target.blocks.change.opcode = 'event_broadcastandwait';
    target.blocks.change.inputs = {BROADCAST_INPUT: [1, [11, 'message', 'message']]};
    target.blocks.change.fields = {};
    target.blocks.receiver = {opcode: 'event_whenbroadcastreceived', parent: null, next: 'add', fields: {BROADCAST_OPTION: ['message', 'message']}, inputs: {}, topLevel: true};
    target.blocks.add = {opcode: 'data_changevariableby', parent: 'receiver', next: null, fields: {VARIABLE: ['answer', 'answer']}, inputs: {VALUE: [1, [4, '1']]}};
  }
  if (category === 'clone' || category === 'pen') {
    const sprite = structuredClone(target);
    Object.assign(sprite, {isStage: false, name: 'Sprite', x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around', visible: true, layerOrder: 1});
    sprite.variables = {}; target.blocks = {};
    project.targets.push(sprite);
    if (category === 'clone') {
      sprite.blocks.change.opcode = 'control_create_clone_of';
      sprite.blocks.change.inputs = {CLONE_OPTION: [1, 'menu']}; sprite.blocks.change.fields = {};
      sprite.blocks.menu = {opcode: 'control_create_clone_of_menu', parent: 'change', next: null, fields: {CLONE_OPTION: ['_myself_', null]}, inputs: {}, shadow: true};
      sprite.blocks.receiver = {opcode: 'control_start_as_clone', parent: null, next: 'delete', inputs: {}, fields: {}, topLevel: true};
      sprite.blocks.delete = {opcode: 'control_delete_this_clone', parent: 'receiver', next: null, inputs: {}, fields: {}};
    } else {
      project.extensions = ['pen'];
      sprite.blocks.change.opcode = 'pen_setPenColorToColor'; sprite.blocks.change.inputs = {COLOR: [1, [9, '#336699']]}; sprite.blocks.change.fields = {};
    }
  }
  const baseline = new VM();
  baseline.setCompilerOptions({enabled: true}); baseline.setTurboMode(true);
  await baseline.loadProject(JSON.stringify(project));
  const input = baseline.exportSpecializedProjectBuildInput();
  const buildStart = performance.now();
  const program = lower(input, 42);
  const boot = `const vm = new Scaffolding.VM(); globalThis.testVM = vm;
    vm.setCompilerOptions({enabled: true}); vm.setTurboMode(true);
    globalThis.testReady = vm.loadProject(${JSON.stringify(JSON.stringify(input.project))});`;
  const built = await linkPlayer({sourcePack, input, program, boot, seed: 'performance'}, rollup);
  const buildMs = performance.now() - buildStart;
  // Run both VMs in the same JS realm. A vm.createContext proxy adds a global
  // lookup tax to every generated Math/Number operation and is not a browser.
  const context = globalThis;
  const globals = {window: context, self: context, document: {createElement: element, head: element(), body: element()}};
  const previousGlobals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(context, key)]));
  Object.assign(context, globals);
  await fs.writeFile(new URL('../../work/performance-player.js', import.meta.url), built.code);
  const start = performance.now();
  try { new vmModule.Script(built.code).runInThisContext(); }
  catch (error) { console.error(error.message, error.stack.split('\n').slice(-5)); throw new Error('Performance player initialization failed'); }
  await context.testReady;
  const startupMs = performance.now() - start;
  const specialized = context.testVM;
  const measure = vm => {
    for (const t of vm.runtime.targets) for (const variable of Object.values(t.variables)) if (variable.type === 'list') variable.value.length = 0;
    const started = performance.now();
    vm.greenFlag();
    while (vm.runtime.threads.some(thread => !thread.updateMonitor)) vm.runtime._step();
    return performance.now() - started;
  };
  const samples = {aot: [], specialized: []};
  for (let round = 0; round < 8; round++) {
    const aot = measure(baseline), fused = measure(specialized);
    if (round >= 3) { samples.aot.push(aot); samples.specialized.push(fused); }
  }
  const median = array => [...array].sort((a, b) => a - b)[2];
  const slowdown = median(samples.specialized) / median(samples.aot) - 1;
  assert.deepEqual(JSON.parse(JSON.stringify(specialized.runtime.targets.map(t => Object.values(t.variables).map(v => v.value)))),
    JSON.parse(JSON.stringify(baseline.runtime.targets.map(t => Object.values(t.variables).map(v => v.value)))));
  report.push({category, samples, medianAOT: median(samples.aot), medianSpecialized: median(samples.specialized),
    p95AOT: Math.max(...samples.aot), p95Specialized: Math.max(...samples.specialized), slowdown, buildMs, startupMs,
    heapUsed: process.memoryUsage().heapUsed, scope: 'CPU execution; pen state update; excludes GPU rasterization'});
  console.log(category, `${(slowdown * 100).toFixed(1)}%`, JSON.stringify(samples));
  if (category === 'compute') {
    const otherBuild = await linkPlayer({sourcePack, input, program: lower(input, 43), boot, seed: 'other-build'}, rollup);
    new vmModule.Script(otherBuild.code).runInThisContext();
    await context.testReady;
    const other = context.testVM;
    measure(other);
    assert.equal(other.runtime.targets[0].variables.answer.value, specialized.runtime.targets[0].variables.answer.value,
      'different seeds preserve execution');
    const sequencer = specialized.runtime.sequencer;
    const stepName = built.diagnostics.propertyMap.stepThread || 'stepThread';
    const otherStepName = otherBuild.diagnostics.propertyMap.stepThread || 'stepThread';
    const original = sequencer[stepName];
    try {
      sequencer[stepName] = other.runtime.sequencer[otherStepName];
      specialized.greenFlag();
      assert.throws(() => specialized.runtime._step(), 'a dispatcher from another build cannot run against this build\'s thread layout');
    } finally { sequencer[stepName] = original; specialized.stopAll(); other.quit(); }
    report.at(-1).crossBuildDispatcherSubstitution = 'rejected';
  }
  baseline.quit(); specialized.quit();
  delete context.testVM; delete context.testReady;
  for (const [key, descriptor] of Object.entries(previousGlobals)) {
    if (descriptor) Object.defineProperty(context, key, descriptor); else delete context[key];
  }
}
await fs.writeFile(new URL('../../work/acceptance/performance-report.json', import.meta.url), JSON.stringify(report, null, 2));
assert(report.every(item => item.slowdown <= 0.1), '10% median CPU regression gate');
