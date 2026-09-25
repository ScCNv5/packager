import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixtureProject} from './specialized-fixtures.mjs';
import {installForTest} from './specialized-differential.mjs';
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const FakeRenderer = require('./test/fixtures/fake-renderer');
const {lower} = require('./src/compiler/continuation');

test('movement, effects and pen renderer operations match JS AOT', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {hidden: false};
  const project = fixtureProject();
  project.monitors = []; project.extensions = ['pen']; project.targets[0].blocks = {};
  const sprite = structuredClone(project.targets[0]);
  Object.assign(sprite, {isStage: false, name: 'Sprite', variables: {}, x: 0, y: 0, direction: 90,
    size: 100, visible: true, draggable: false, rotationStyle: 'all around', layerOrder: 1});
  project.targets.push(sprite);
  const block = (opcode, parent, next, inputs = {}, fields = {}) => ({opcode, parent, next, inputs, fields, topLevel: !parent});
  sprite.blocks = {
    hat: block('event_whenflagclicked', null, 'clear'),
    clear: block('pen_clear', 'hat', 'down'),
    down: block('pen_penDown', 'clear', 'repeat'),
    repeat: block('control_repeat', 'down', 'up', {TIMES: [1, [4, '10']], SUBSTACK: [2, 'move']}),
    move: block('motion_changexby', 'repeat', 'effect', {DX: [1, [4, '2']]}),
    effect: block('looks_changeeffectby', 'move', null, {CHANGE: [1, [4, '5']]}, {EFFECT: ['ghost', null]}),
    up: block('pen_penUp', 'repeat', null)
  };
  const run = async specialized => {
    const vm = new VM(), renderer = new FakeRenderer(), trace = [];
    for (const name of ['createPenSkin', 'penClear', 'penLine', 'penPoint', 'penStamp', 'destroySkin', 'destroyDrawable', 'draw']) renderer[name] = () => 1;
    renderer.getNativeSize = () => [480, 360];
    for (const name of ['updateDrawablePosition', 'updateDrawableEffect', 'penClear', 'penLine', 'penPoint', 'penStamp']) {
      const original = renderer[name];
      renderer[name] = (...args) => { trace.push([name, JSON.parse(JSON.stringify(args))]); return original.apply(renderer, args); };
    }
    try {
      vm.attachRenderer(renderer); vm.setCompilerOptions({enabled: true});
      await vm.loadProject(JSON.stringify(project));
      if (specialized) installForTest(vm, lower(vm.exportSpecializedProjectBuildInput(), 51));
      trace.length = 0; vm.greenFlag();
      for (let tick = 0; tick < 50 && vm.runtime.threads.length; tick++) vm.runtime._step();
      assert(!vm.runtime.threads.length);
      return trace;
    } finally { vm.quit(); }
  };
  const expected = await run(false), actual = await run(true);
  assert(expected.some(([method]) => method === 'penLine'));
  assert.deepEqual(actual, expected);
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
});
