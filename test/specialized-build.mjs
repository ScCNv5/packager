import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fixtureProject, fixedExtension, costumeId, costumeSVG} from './specialized-fixtures.mjs';
import {auditArtifact} from '../src/specialized/link.mjs';
const require = createRequire(import.meta.url);
const {compileProject, Packager, loadProject} = require('../dist/packager.js');
const JSZip = require('@turbowarp/jszip');
const out = new URL('../../work/acceptance/', import.meta.url);
await fs.mkdir(out, {recursive: true});
const bytes = async project => new JSZip().file('project.json', JSON.stringify(project)).file(`${costumeId}.svg`, costumeSVG)
  .generateAsync({type: 'uint8array'});
const data = await bytes(fixtureProject());
const first = await compileProject(data, {seed: 'acceptance', autoplay: false});
const second = await compileProject(data, {seed: 'acceptance', autoplay: false, sourceMap: true});
assert.equal(first.code, second.code, 'explicit seed reproduces the player');
assert.deepEqual(first.assets, second.assets, 'explicit seed reproduces resources');
assert.equal(first.buildId, second.buildId);
assert(second.sourceMap.sources.some(source => source.includes('sequencer')));
assert(!first.code.includes('sourceMappingURL=') && !first.sourceMap);
auditArtifact(first.code);
for (const name of ['stepThread', 'stepThreads', 'retireThread', 'getIdFromTargetAndBlock', 'peekStack']) {
  assert(first.diagnostics.propertyMap[name], `${name} must participate in joint scheduling renaming`);
  assert(!first.code.includes(`.${name}(`), `${name} must not survive as an unchanged call`);
}
assert(!first.code.includes('__spOwner'), 'build-only ownership markers must not enter the player');
assert(!first.diagnostics.propertyMap.status && !first.diagnostics.propertyMap.value);
assert(first.diagnostics.removedModules.some(id => id.includes('/PenSkin')));
assert(!first.diagnostics.retainedModules.some(id => id.includes('/scratch-audio/')));
assert(!first.diagnostics.retainedModules.some(id => /\/io\/video\.js/.test(id)));
assert.equal(first.diagnostics.commonJSWrappers.length, 2);
assert(first.diagnostics.commonJSWrappers.every(item => item.sha256.length === 64 && item.cycle.length === 3));
assert(!first.code.includes('__webpack_require__'));
const zip = await JSZip.loadAsync(first.assets[0].data);
const initial = JSON.parse(await zip.file('project.json').async('string'));
assert(initial.targets.every(target => Object.keys(target.blocks).length === 0 && Object.keys(target.comments).length === 0));
assert.deepEqual(Object.keys(zip.files).sort(), [`${costumeId}.svg`, 'project.json'].sort());
await fs.writeFile(new URL('player.js', out), first.code);
await fs.writeFile(new URL('project.zip', out), first.assets[0].data);
await fs.writeFile(new URL('index.html', out), '<!DOCTYPE html><html><body><script src="player.js"></script></body></html>');
const packager = new Packager();
packager.project = await loadProject(data);
packager.options.compiler.seed = 'acceptance';
packager.options.autoplay = false;
packager.options.cloudVariables.mode = 'none';
const html = await packager.package();
await fs.writeFile(new URL('embedded.html', out), new Uint8Array(html.data));
const zipped = new Packager();
zipped.project = await loadProject(data);
zipped.options.compiler.seed = 'acceptance';
zipped.options.autoplay = false;
zipped.options.cloudVariables.mode = 'none';
zipped.options.target = 'zip';
const webZip = await JSZip.loadAsync((await zipped.package()).data);
assert.equal(zipped.buildResult.code, packager.buildResult.code, 'HTML and ZIP share the exact linked code');
await fs.mkdir(new URL('zip/', out), {recursive: true});
for (const [name, file] of Object.entries(webZip.files)) {
  assert(!name.includes('..') && !name.startsWith('/'));
  if (!file.dir) await fs.writeFile(new URL(`zip/${name}`, out), await file.async('uint8array'));
}
await fs.writeFile(new URL('player-web.zip', out), (await webZip.generateAsync({type: 'uint8array'})));
const fixed = await compileProject(await bytes(fixtureProject({extension: true, branch: true})),
  {seed: 'extension', autoplay: false, extensions: [fixedExtension]});
await fs.mkdir(new URL('extension/', out), {recursive: true});
await fs.writeFile(new URL('extension/player.js', out), fixed.code);
await fs.writeFile(new URL('extension/project.zip', out), fixed.assets[0].data);
await fs.writeFile(new URL('extension/index.html', out), '<!DOCTYPE html><html><body><script src="player.js"></script></body></html>');
const drawing = fixtureProject();
const stage = drawing.targets[0];
const sprite = {...structuredClone(stage), isStage: false, name: 'Pen', variables: {},
  visible: false, x: 0, y: 0, direction: 90, size: 100, rotationStyle: 'all around', layerOrder: 1};
stage.blocks = {};
sprite.blocks = {};
const commands = [
  ['event_whenflagclicked', {}], ['pen_clear', {}],
  ['pen_setPenSizeTo', {SIZE: [1, [4, '10']]}],
  ['pen_setPenColorToColor', {COLOR: [1, [9, '#ff0000']]}],
  ['pen_penDown', {}], ['motion_gotoxy', {X: [1, [4, '80']], Y: [1, [4, '0']]}], ['pen_penUp', {}],
  ['data_setvariableto', {VALUE: [1, [4, '1']]}, {VARIABLE: ['answer', 'answer']}]
];
commands.forEach(([opcode, inputs, fields = {}], index) => {
  sprite.blocks[`b${index}`] = {opcode, inputs, fields, topLevel: index === 0,
    parent: index ? `b${index - 1}` : null, next: index + 1 < commands.length ? `b${index + 1}` : null};
});
drawing.targets.push(sprite); drawing.extensions = ['pen'];
const rendered = await compileProject(await bytes(drawing), {seed: 'rendering', autoplay: false});
assert(rendered.diagnostics.retainedModules.some(id => id.includes('/PenSkin')));
await fs.mkdir(new URL('rendering/', out), {recursive: true});
await fs.writeFile(new URL('rendering/player.js', out), rendered.code);
await fs.writeFile(new URL('rendering/project.zip', out), rendered.assets[0].data);
await fs.writeFile(new URL('rendering/index.html', out), '<!DOCTYPE html><html><body><script src="player.js"></script></body></html>');
await fs.writeFile(new URL('build-report.json', out), JSON.stringify({first: first.diagnostics, fixed: fixed.diagnostics}, null, 2));
console.log('Build, reproducibility, capability removal, source stripping, HTML, and fixed extension checks passed.');
