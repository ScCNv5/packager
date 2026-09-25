// CPU regression runner for Scratch Benchmark 441947766, supplied by the caller.
// Preserve every script in the linked program; invoke one original Bench Workload
// at a time to exclude its wall-clock score calculation, GPU work and cloud I/O.
import fs from 'node:fs/promises';
import path from 'node:path';
import vmModule from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {performance} from 'node:perf_hooks';
import {rollup} from 'rollup';
import JSZip from '@turbowarp/jszip';
import {linkPlayer} from '../src/specialized/link.mjs';

const [projectPath, outputPath = '../work/acceptance/scratch-benchmark-report.json', seed = 'scratch-benchmark'] = process.argv.slice(2);
if (!projectPath) throw new Error('Usage: node test/specialized-scratch-benchmark.mjs <original.sb3|project.json> [report.json] [seed]');
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const {lower} = require('./src/compiler/continuation');
const sourcePack = JSON.parse(await fs.readFile(new URL('../generated/runtime-sources.json', import.meta.url)));
const bytes = await fs.readFile(projectPath);
const project = JSON.parse(bytes[0] === 0x50 ? await (await JSZip.loadAsync(bytes)).file('project.json').async('string') : bytes);
const names = ['PRNG', 'TerrainGen', 'Raycaster', 'Quicksort', 'ListSearch', 'StringParse'];
assert(names.every(name => project.targets.some(target => target.name === name)), 'Expected original Scratch Benchmark 441947766');
project.monitors = [];
for (const target of project.targets) {
  target.costumes = []; target.sounds = [];
  for (const variable of Object.values(target.variables)) if (variable[2]) variable.length = 2;
  if (!names.includes(target.name)) continue;
  let found = false;
  for (const hat of Object.values(target.blocks)) {
    if (hat.opcode !== 'event_whenbroadcastreceived') continue;
    for (let id = hat.next; id;) {
      const block = target.blocks[id];
      if (block.opcode === 'procedures_call' && block.mutation.proccode === 'Bench Workload') {
        block.next = null; found = true; break;
      }
      id = block.next;
    }
  }
  assert(found, `Missing workload in ${target.name}`);
}
const baseline = new VM();
baseline.setCompilerOptions({enabled: true}); baseline.setTurboMode(true);
let specialized;
const globals = {};
const originalRandom = Math.random;
try {
  await baseline.loadProject(JSON.stringify(project));
  const input = baseline.exportSpecializedProjectBuildInput();
  // Match the public compiler's seed hashing.
  let numericSeed = 2166136261;
  for (const char of seed) numericSeed = Math.imul(numericSeed ^ char.charCodeAt(0), 16777619);
  const buildStarted = performance.now();
  const built = await linkPlayer({sourcePack, input, program: lower(input, numericSeed >>> 0), seed,
    boot: `const vm = new Scaffolding.VM(); globalThis.benchmarkVM = vm; vm.setTurboMode(true);
      globalThis.benchmarkReady = vm.loadProject(${JSON.stringify(JSON.stringify(input.project))});`}, rollup);
  const buildMs = performance.now() - buildStarted;
  const element = () => ({style: {}, appendChild() {}, insertBefore() {}, setAttribute() {}, getContext() { return null; }});
  for (const [key, value] of Object.entries({window: globalThis, self: globalThis,
    document: {hidden: false, createElement: element, head: element(), body: element()}})) {
    globals[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  }
  new vmModule.Script(built.code).runInThisContext();
  await globalThis.benchmarkReady;
  specialized = globalThis.benchmarkVM;
  let random;
  const seededRandom = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    return random / 4294967296;
  };
  const run = (vm, name, iterations) => {
    random = 1;
    const target = vm.runtime.getSpriteTargetByName(name);
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      vm.runtime.startHats('event_whenbroadcastreceived', {BROADCAST_OPTION: `Bench ${name}`}, target);
      while (vm.runtime.threads.length) vm.runtime._step();
    }
    return (performance.now() - started) / iterations;
  };
  const values = (vm, name) => structuredClone(Object.values(vm.runtime.getSpriteTargetByName(name).variables).map(v => v.value));
  const report = {project: 'https://scratch.mit.edu/projects/441947766/',
    sourceSHA256: createHash('sha256').update(bytes).digest('hex'), node: process.version, seed,
    codeSHA256: createHash('sha256').update(built.code).digest('hex'),
    scope: 'Same-realm CPU execution, full linked/minified program, original workload procedures; excludes GPU, assets and score timing',
    warmupRounds: 3, measuredRounds: 5, buildMs, dispatchGroups: built.diagnostics.dispatchGroups.length, results: []};
  Math.random = seededRandom;
  if (process.env.BENCH_PROFILE) {
    const {Session} = await import('node:inspector/promises');
    const session = new Session(); session.connect();
    run(specialized, 'Raycaster', 1000);
    await session.post('Profiler.enable'); await session.post('Profiler.start');
    run(specialized, 'Raycaster', 5000);
    const {profile} = await session.post('Profiler.stop'); session.disconnect();
    await fs.writeFile(`${outputPath}.cpuprofile`, JSON.stringify(profile));
    await fs.writeFile(`${outputPath}.js`, built.code);
    await fs.writeFile(`${outputPath}.maps.json`, JSON.stringify(built.diagnostics.propertyMap));
    run(baseline, 'Raycaster', 1000);
    run(baseline, 'Raycaster', 5000);
    report.additionalWarmup = {Raycaster: 6000};
  }
  for (const name of names) {
    const samples = {aot: [], specialized: []};
    const iterations = name === 'ListSearch' ? 5 : 50;
    for (let round = 0; round < 8; round++) {
      let aot, fused;
      if (round % 2) { fused = run(specialized, name, iterations); aot = run(baseline, name, iterations); }
      else { aot = run(baseline, name, iterations); fused = run(specialized, name, iterations); }
      assert.deepEqual(values(specialized, name), values(baseline, name), `${name} state mismatch`);
      if (round >= 3) { samples.aot.push(aot); samples.specialized.push(fused); }
    }
    const median = values => [...values].sort((a, b) => a - b)[2];
    const aotMs = median(samples.aot), specializedMs = median(samples.specialized);
    const result = {name, iterations, aotMs, specializedMs, slowdown: specializedMs / aotMs - 1,
      p95AOT: Math.max(...samples.aot), p95Specialized: Math.max(...samples.specialized), samples};
    report.results.push(result);
    console.log(`${name}: ${(result.slowdown * 100).toFixed(1)}%`, JSON.stringify(samples));
  }
  report.passed = report.results.every(result => result.slowdown <= 0.1);
  await fs.mkdir(path.dirname(outputPath), {recursive: true});
  await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
  assert(report.passed, '10% median CPU regression gate');
} finally {
  Math.random = originalRandom;
  baseline.quit(); specialized?.quit();
  delete globalThis.benchmarkVM; delete globalThis.benchmarkReady;
  for (const [key, descriptor] of Object.entries(globals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
