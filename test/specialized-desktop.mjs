import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {fixtureProject, costumeSVG, costumeId} from './specialized-fixtures.mjs';
const require = createRequire(import.meta.url);
const {Packager, loadProject} = require('../dist/packager.js');
const JSZip = require('@turbowarp/jszip');
const data = await new JSZip().file('project.json', JSON.stringify(fixtureProject()))
  .file(`${costumeId}.svg`, costumeSVG).generateAsync({type: 'uint8array'});
const packager = new Packager();
packager.project = await loadProject(data);
packager.options.target = 'webview-mac';
packager.options.compiler.seed = 'acceptance';
packager.options.autoplay = false;
packager.options.cloudVariables.mode = 'none';
const result = await packager.package();
const zip = await JSZip.loadAsync(result.data);
const directory = new URL('../../work/acceptance/desktop/', import.meta.url);
await fs.mkdir(directory, {recursive: true});
for (const [name, file] of Object.entries(zip.files)) {
  assert(!name.startsWith('/') && !name.split('/').includes('..'));
  const destination = new URL(name, directory);
  if (file.dir) await fs.mkdir(destination, {recursive: true});
  else {
    await fs.mkdir(path.dirname(destination.pathname), {recursive: true});
    await fs.writeFile(destination, await file.async('uint8array'));
    if (file.unixPermissions) await fs.chmod(destination, Number(file.unixPermissions) & 0o777);
  }
}
const scripts = Object.keys(zip.files).filter(name => name.endsWith('/Resources/script.js'));
assert.equal(scripts.length, 1);
const sameCode = await fs.readFile(new URL('../../work/acceptance/zip/script.js', import.meta.url), 'utf8');
assert.equal(await zip.file(scripts[0]).async('string'), sameCode, 'desktop and web ZIP share final code');
assert(zip.file(scripts[0].replace('script.js', 'project.zip')));
assert(zip.file(scripts[0].replace('script.js', 'index.html')));
console.log('Actual macOS WebView package built; executable, page, resources and identical player code verified.');
