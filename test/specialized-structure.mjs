import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {auditArtifact, stepBody, stepMethods, dispatchGroups} from '../src/specialized/link.mjs';
import {fixtureProject} from './specialized-fixtures.mjs';
import {prepareExtension} from '../src/specialized/extensions.mjs';
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const {lower} = require('./src/compiler/continuation');
test('structural audit tracks aliases and computed execution APIs', () => {
  for (const code of ['eval("x")', 'const F = Function; new F("x")', 'globalThis["Function"]("x")',
    '(0, eval)("x")', 'const e = eval; e.call(null, "x")', 'import("x")', 'self.importScripts("x")', 'setTimeout("x", 0)', 'function* f() {}']) {
    assert.throws(() => auditArtifact(code), /forbidden execution paths/);
  }
  auditArtifact('function step(thread) { while (thread.pc) switch(thread.pc) { case 1: thread.pc=0; break; } }');
});
test('VM access in a deferred extension method is rejected during the build', async () => {
  const url = 'https://test.invalid/extension.js';
  for (const source of ['function later() { return Scratch.vm; }', 'function later() { return vm.runtime; }',
    'function later() { Scratch.extensions.loadExtensionURL("x"); }']) {
    await assert.rejects(prepareExtension({url, sources: {[url]: source}}, {}, () => { throw new Error('Should not reach linking'); }),
      /cannot access|cannot load/);
  }
});
test('seeded continuations share dispatch with lifecycle logic and cap switch regions', async () => {
  const vm = new VM();
  try {
    const project = fixtureProject();
    const blocks = project.targets[0].blocks;
    for (let i = 0; i < 300; i++) {
      blocks[`hat${i}`] = {opcode: 'event_whenflagclicked', parent: null, next: null, topLevel: true, fields: {}, inputs: {}};
    }
    await vm.loadProject(JSON.stringify(project));
    const input = vm.exportSpecializedProjectBuildInput();
    const a = lower(input, 1), b = lower(input, 2);
    assert.notDeepEqual(a.blocks.map(block => block.id), b.blocks.map(block => block.id));
    assert.equal(new Set(a.hats.map(hat => hat.pc)).size, 301);
    const code = stepBody(a.blocks);
    assert(code.includes('retireThread') && code.includes('__spFrames.pop'));
    for (const group of code.split('switch (frame.__spPC)').slice(1)) assert((group.match(/case /g) || []).length <= 256);
    assert(!code.includes('function*') && !code.includes('function step'));
    const methods = stepMethods(a.blocks);
    const groups = dispatchGroups(a.blocks);
    assert(groups.length > 1);
    assert.equal(Object.keys(methods).length, groups.length + 1, 'groups must be separate VM methods');
    assert(!methods.stepThread.includes('case '), 'scheduler must not contain the entire program');
    assert(groups.every(group => group.length <= 256));
    assert(groups.some(group => new Set(group.map(block => block.owner)).size > 1));
    assert(groups.every(group => group.length === 1 || group.reduce((sum, b) => sum + b.code.join('\n').length, 0) <= 12000));
    const encoded = groups.flatMap((group, index) => group.map((block, offset) =>
      ({...block, id: (index + 1) * 256 + offset, dispatchGroup: index + 1})));
    assert(stepMethods(encoded).stepThread.includes('switch (pc >>> 8)'), 'production routing uses encoded group PCs');
  } finally { vm.quit(); }
});
