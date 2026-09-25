import fs from 'node:fs/promises';
import {rollup} from 'rollup';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';

await fs.mkdir('generated', {recursive: true});
for (const node of [true, false]) {
  const bundle = await rollup({input: `src/specialized/${node ? 'node' : 'worker'}.mjs`,
    external: node ? ['rollup', 'node:child_process'] : [],
    onwarn(warning) { if (warning.code !== 'CIRCULAR_DEPENDENCY') console.warn(warning.message); },
    plugins: [{name: 'build-environment', transform(code, id) {
      if (!/\.[cm]?js$/.test(id)) return;
      return {code: code.replace(/process\.env\.BABEL_TYPES_8_BREAKING/g, 'false')
        .replace(/process\.env\.BABEL_8_BREAKING/g, 'false').replace(/process\.env\.BABEL_TYPES_8_BREAKING/g, 'false')
        .replace(/process\.env\.NODE_ENV/g, '"production"'), map: null};
    }}, nodeResolve({browser: !node, preferBuiltins: node}), commonjs(), json()]});
  await bundle.write({file: `generated/${node ? 'specialized-link.cjs' : 'specialized-worker.js'}`,
    format: node ? 'cjs' : 'iife', inlineDynamicImports: true,
    banner: node ? '' : 'var global = globalThis; var process = {env: {}, platform: "browser"};'});
  await bundle.close();
}
const browserRollup = await fs.readFile('node_modules/@rollup/browser/dist/rollup.browser.js', 'utf8');
const wasmBootstrap = /(\w+)=new URL\("bindings_wasm_bg.wasm",/;
if (!wasmBootstrap.test(browserRollup)) throw new Error('Pinned Rollup WASM bootstrap changed');
await fs.writeFile('generated/rollup.browser.js', browserRollup.replace(wasmBootstrap,
  '$1=globalThis.__specializedWasmBytes||new URL("bindings_wasm_bg.wasm",'));
await fs.copyFile('node_modules/@rollup/browser/dist/bindings_wasm_bg.wasm', 'generated/bindings_wasm_bg.wasm');
