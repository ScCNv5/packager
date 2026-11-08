import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {rollup} from 'rollup';
import {linkPlayer} from '../src/specialized/link.mjs';
import {fixtureProject} from './specialized-fixtures.mjs';
const require = createRequire(new URL('../../scratch-vm/package.json', import.meta.url));
const VM = require('./src/virtual-machine');
const {lower} = require('./src/compiler/continuation');
const sourcePack = JSON.parse(await fs.readFile(new URL('../generated/runtime-sources.json', import.meta.url)));
const vm = new VM();
try {
  await vm.loadProject(JSON.stringify(fixtureProject()));
  const input = vm.exportSpecializedProjectBuildInput();
  const data = {input, program: lower(input, 100), seed: 'parity', aggressiveRenaming: process.argv.includes('--aggressive'),
    boot: 'const vm = new Scaffolding.VM(); vm.quit();'};
  const node = await linkPlayer({...data, sourcePack}, rollup);
  const directory = new URL('../../work/acceptance/', import.meta.url);
  await fs.writeFile(new URL('worker-input.json', directory), JSON.stringify({data, expected: createHash('sha256').update(node.code).digest('hex')}));
  await fs.writeFile(new URL('worker.html', directory), '<!DOCTYPE html><html><body>Worker acceptance</body></html>');
  for (const file of ['specialized-worker.js', 'rollup.browser.js', 'bindings_wasm_bg.wasm']) {
    await fs.copyFile(new URL(`../generated/${file}`, import.meta.url), new URL(file, directory));
  }
} finally { vm.quit(); }
