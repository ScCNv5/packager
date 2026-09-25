import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {installForTest} from './specialized-differential.mjs';
import {fixtureProject} from './specialized-fixtures.mjs';
import pause from '../src/addons/pause.js';
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const {lower} = require('./src/compiler/continuation');
const pending = [];
class Extension {
  getInfo() { return {id: 'fixture', name: 'Fixture', blocks: [{opcode: 'value', blockType: 'reporter', text: 'value'}]}; }
  value() { return new Promise(resolve => pending.push(resolve)); }
}
async function setup() {
  pending.length = 0;
  const vm = new VM();
  vm.extensionManager.addBuiltinExtension('fixture', Extension);
  await vm.loadProject(JSON.stringify(fixtureProject({extension: true})));
  installForTest(vm, lower(vm.exportSpecializedProjectBuildInput(), 45));
  return vm;
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const value = vm => vm.runtime.getTargetForStage().variables.answer.value;

test('an old Promise cannot revive a stopped/restarted program', async () => {
  const vm = await setup();
  try {
    vm.greenFlag(); vm.runtime._step();
    assert.equal(pending.length, 1);
    const old = vm.runtime.threads.find(thread => !thread.updateMonitor);
    vm.stopAll(); vm.greenFlag(); vm.runtime._step();
    assert.equal(pending.length, 2);
    pending[0](123); await settle(); vm.runtime._step();
    assert.equal(value(vm), 0);
    assert.equal(vm.runtime.threads.includes(old), false);
    pending[1](42); await settle(); vm.runtime._step();
    assert.equal(value(vm), 42);
  } finally { vm.quit(); }
});

test('pausing preserves a completed Promise until resume, without an audio engine', async () => {
  const vm = await setup();
  try {
    pause({scaffolding: {vm}});
    vm.greenFlag(); vm.runtime._step(); vm.setPaused(true);
    pending[0](42); await settle(); vm.runtime._step();
    assert.equal(value(vm), 0);
    vm.setPaused(false); vm.runtime._step();
    assert.equal(value(vm), 42);
  } finally { vm.quit(); }
});

test('restarting a waiting hat invalidates only the old invocation', async () => {
  const vm = await setup();
  try {
    vm.greenFlag(); vm.runtime._step();
    const old = vm.runtime.threads.find(thread => !thread.updateMonitor);
    const replacement = vm.runtime._restartThread(old);
    assert.notEqual(replacement, old);
    vm.runtime._step();
    pending[0](123); await settle(); vm.runtime._step();
    assert.equal(value(vm), 0);
    pending[1](42); await settle(); vm.runtime._step();
    assert.equal(value(vm), 42);
  } finally { vm.quit(); }
});
