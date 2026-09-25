const pathUtil = require('path');
const fs = require('fs');

const dist = pathUtil.join(__dirname, '..', '..', 'dist');
console.log(`dist: ${dist}`);

const buildAssets = {};
for (const name of ['specialized-worker.js', 'rollup.browser.js', 'bindings_wasm_bg.wasm']) {
  buildAssets[name] = fs.readFileSync(pathUtil.join(dist, name)).toString('base64');
}

const indexPath = pathUtil.join(dist, 'index.html');
console.log(`index.html: ${indexPath}`);
const indexContent = fs.readFileSync(indexPath, 'utf8');

const jsPath = pathUtil.join(dist, indexContent.match(/<script src="(.*)"><\/script>/)[1]);
console.log(`packager.js: ${jsPath}`);
const jsContent = fs.readFileSync(jsPath, 'utf-8');

const faviconPath = pathUtil.join(__dirname, '../../static/favicon.ico');
const faviconData = fs.existsSync(faviconPath) ? fs.readFileSync(faviconPath) : null;
console.log(`favicon.ico: ${faviconData ? faviconPath : 'none'}`);

const makeSafeForInlineScript = (content) => content.replace(/<\/script>/g, '\\u003c/script>');
let standaloneJS = '';
standaloneJS += Object.entries(buildAssets).map(([name, content]) => (
  `<script type="p4-standalone-asset" data-name="${name}">${content}</script>`
)).join('');
standaloneJS += `<script>
window.__ASSETS__ = {};
for (const el of Array.from(document.querySelectorAll('script[type="p4-standalone-asset"]'))) {
  __ASSETS__[el.dataset.name] = el.dataset.name.endsWith('.wasm') ? el.textContent :
    new TextDecoder().decode(Uint8Array.from(atob(el.textContent), c => c.charCodeAt(0)));
  el.remove();
}
</script>`;

let newContent = indexContent;
if (faviconData) {
  newContent = newContent.replace(/<\/head>/, `<link rel="shortcut icon" href="data:image/vnd.microsoft.icon;base64,${faviconData.toString('base64')}"></head>`);
}
newContent = newContent.replace(/<script src=".*"><\/script>/, () => (
  `${standaloneJS}<script>${makeSafeForInlineScript(jsContent)}</script>`
));

const standalonePath = pathUtil.join(dist, 'standalone.html');
console.log(`standalone.html: ${standalonePath}`);
fs.writeFileSync(standalonePath, newContent);
