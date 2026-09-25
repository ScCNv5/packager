import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {chromium} from '@playwright/test';
import {fixtureProject, costumeSVG, costumeId} from './specialized-fixtures.mjs';
const require = createRequire(import.meta.url);
const JSZip = require('@turbowarp/jszip');
const bytes = await new JSZip().file('project.json', JSON.stringify(fixtureProject()))
  .file(`${costumeId}.svg`, costumeSVG).generateAsync({type: 'nodebuffer'});
const browser = await chromium.launch({headless: true});
try {
  const context = await browser.newContext({acceptDownloads: true, locale: 'en-US'});
  const page = await context.newPage();
  page.on('pageerror', error => console.error('page error:', error.stack));
  page.on('requestfailed', request => console.error('request failed:', request.url().slice(0, 200), request.failure()));
  await page.goto(new URL('../dist/standalone.html', import.meta.url).href);
  await context.setOffline(true);
  await page.locator('input[type=radio][value=file]').check();
  await page.locator('input[type=file][accept=".sb,.sb2,.sb3"]').setInputFiles({name: 'fixture.sb3', mimeType: 'application/octet-stream', buffer: bytes});
  await page.getByRole('button', {name: 'Package', exact: true}).waitFor({timeout: 30000});
  const download = page.waitForEvent('download', {timeout: 180000});
  await page.getByRole('button', {name: 'Package', exact: true}).click();
  const file = await download.catch(async error => { console.error((await page.locator('body').innerText()).slice(-2000)); throw error; });
  const path = new URL('../../work/acceptance/standalone-output.html', import.meta.url);
  await file.saveAs(path.pathname);
  const html = await fs.readFile(path, 'utf8');
  assert(html.includes('player-resources') && !html.includes('sourceMappingURL='));
  const player = await context.newPage();
  player.on('pageerror', error => console.error('player error:', error.message));
  await player.addInitScript(() => {
    Object.defineProperty(window, 'player', {configurable: true, set(value) {
      Object.defineProperty(window, 'player', {value});
      value.on('loaded', () => { window.testLoaded = true; });
      value.on('error', event => { window.testError = event.message; });
    }});
  });
  await player.goto(path.href);
  await player.waitForFunction(() => window.testLoaded || window.testError);
  assert.equal(await player.evaluate(() => window.testError), undefined);
  await player.evaluate(() => window.player.start());
  await player.waitForFunction(() => window.player && [...document.querySelectorAll('.sc-monitor-value')].some(node => node.textContent === '53'));
  await player.evaluate(() => window.player.dispose());
  console.log('Offline standalone UI built and played an HTML player without filesystem plugins or remote code resolution.');
} finally { await browser.close(); }
