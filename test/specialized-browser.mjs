import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, firefox, webkit} from '@playwright/test';
import {PNG} from 'pngjs';

const root = path.resolve(fileURLToPath(new URL('../../work/acceptance/', import.meta.url)));
const server = http.createServer(async (request, response) => {
  try {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${name.endsWith('/') ? `${name}index.html` : name}`);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Invalid path');
    const bytes = await fs.readFile(file);
    response.setHeader('Content-Type', ({'.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json'})[path.extname(file)] || 'application/octet-stream');
    response.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data:");
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const [name, engine] of Object.entries({chromium, firefox, webkit})) {
    const browser = await engine.launch({headless: true});
    try {
      for (const [file, expected] of [['index.html', '53'], ['embedded.html', '53'], ['zip/index.html', '53'], ['extension/index.html', '43'], ['rendering/index.html', '1']]) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
          window.testEvents = []; window.testCSP = [];
          document.addEventListener('securitypolicyviolation', event => window.testCSP.push(event.violatedDirective));
          Object.defineProperty(window, 'player', {configurable: true, set(value) {
            Object.defineProperty(window, 'player', {value, configurable: true});
            for (const event of ['loaded', 'error', 'state']) value.on(event, data => window.testEvents.push(data));
          }});
        });
        await page.goto(`${origin}/${file}`);
        await page.waitForFunction(() => window.testEvents.some(event => event.type === 'loaded' || event.type === 'error')).catch(async error => {
          console.error(name, file, errors, await page.evaluate(() => ({events: window.testEvents, csp: window.testCSP, body: document.body.innerText.slice(0, 600)})));
          throw error;
        });
        assert.deepEqual(await page.evaluate(() => window.testEvents.filter(event => event.type === 'error')), [], `${name}/${file}: loading`);
        assert.deepEqual(await page.evaluate(() => Object.keys(window.player).sort()), ['dispose', 'off', 'on', 'pause', 'postInput', 'resume', 'start', 'stop']);
        assert(await page.evaluate(() => !window.vm && !window.scaffolding && Object.isFrozen(window.player)));
        await page.evaluate(() => { window.player.start(); window.player.pause(); });
        await page.evaluate(() => { window.player.postInput('keyboard', {key: 'a', isDown: true}); window.player.resume(); });
        await page.waitForFunction(value => [...document.querySelectorAll('.sc-monitor-value')].some(node => node.textContent === value), expected);
        if (file.startsWith('rendering/')) {
          const pixels = PNG.sync.read(await page.locator('canvas').first().screenshot());
          let red = 0;
          for (let index = 0; index < pixels.data.length; index += 4) {
            if (pixels.data[index] > 200 && pixels.data[index + 1] < 50 && pixels.data[index + 2] < 50) red++;
          }
          assert(red > 100, `${name}: actual WebGL pen output (${red} red pixels)`);
        }
        await page.evaluate(() => { window.player.stop(); window.player.dispose(); window.player.dispose(); });
        assert.equal(await page.locator('canvas').count(), 0, 'dispose removes the player');
        assert.deepEqual(await page.evaluate(() => window.testCSP), [], `${name}/${file}: CSP`);
        assert.deepEqual(errors, [], `${name}/${file}: runtime errors`);
        results.push({browser: name, format: file, result: 'passed'});
        console.log(`${name}: ${file} passed`);
        await page.close();
      }
      const page = await browser.newPage();
      await page.goto(`${origin}/worker.html`);
      const parity = await page.evaluate(async () => {
        const {data, expected} = await (await fetch('worker-input.json')).json();
        const worker = new Worker('specialized-worker.js');
        const result = await new Promise((resolve, reject) => {
          worker.onmessage = ({data}) => data.error ? reject(new Error(data.error)) : resolve(data.result);
          worker.onerror = event => reject(new Error(event.message));
          worker.postMessage(data);
        }).finally(() => worker.terminate());
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.code));
        return {expected, actual: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')};
      });
      assert.equal(parity.actual, parity.expected, `${name}: Worker/Node same seed`);
      console.log(`${name}: Worker/Node parity passed`);
      results.push({browser: name, format: 'build-worker', result: 'passed'});
      await page.close();
    } finally { await browser.close(); }
  }
  await fs.writeFile(path.join(root, 'browser-report.json'), JSON.stringify(results, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
