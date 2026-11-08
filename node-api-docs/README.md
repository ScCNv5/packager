# Node.js API

## Installing

```bash
npm install --save-exact @luyifei2011/tw-packager
```

We suggest that you use `--save-exact` (or, with yarn, `--exact`) to make sure you always install the same version. This is important because we don't promise API compatibility across even minor updates.

## About the API

### Stability

The Node.js API is still in beta.

There are no promises of API stability between updates even across minor updates. Always pin to an exact version and don't update without testing. We don't go out of our way to break the API, but we don't let it stop us from making changes. We try to mention noteworthy changes in the [GitHub releases](https://github.com/TurboWarp/packager/releases) changelog.

### Release cadence

We intend to release an updated version of the npm module to npm with every update of [TurboWarp Desktop](https://github.com/TurboWarp/desktop), which currently happens about once a month.

### Feature support

All features should work, with the following exceptions:

 - macOS apps in the NW.js or WKWebView environments do not support custom icons and must always use the default icon

### Browser support

The Node.js module as published on npm is not intended to work in a browser regardless of any build tool such as webpack. If you need to run in a browser, fork this repository directly and modify the interface as you see fit.

### Large assets

Large assets such as Electron binaries are not stored in this repository and will be downloaded from a remote server on demand. While we aren't actively removing old files, we can't promise they will exist forever. Downloads are validated with a SHA-256 checksum and cached locally.

Large assets are cached in `node_modules/@luyifei2011/tw-packager/.packager-cache`. You may want to periodically clean this folder.

## Using the API

See demo.js or demo-simple.js for a full example.

First, you can import the module like this:

```js
const Packager = require('@luyifei2011/tw-packager');
```

### Load a project

Next you have to get a project file from somewhere. It can be a project.json or a full sb, sb2, or sb3 file. The packager doesn't provide any API for this, you have to find it on your own. Your data must be an ArrayBuffer, Uint8Array, or Node.js Buffer.

```js
// Fetch a remote URL:
const fetch = require('cross-fetch').default; // or whatever your favorite HTTP library is
const projectData = await (await fetch('https://packager.turbowarp.org/example.sb3')).arrayBuffer();

// or use a local file:
const fs = require('fs');
const projectData = fs.readFileSync('project.sb3');

// or fetch a shared Scratch project:
const fetch = require('cross-fetch').default; // or whatever your favorite HTTP library is
const id = '437419376';
const projectMetadata = await (await fetch(`https://trampoline.turbowarp.org/api/projects/${id}`)).json();
const token = projectMetadata.project_token;
const projectData = await (await fetch(`https://projects.scratch.mit.edu/${id}?token=${token}`)).arrayBuffer();
```

Now you have to tell the packager to load the project. The packager will parse it, do some analysis, and download any needed assets if the input was just a project.json. This must be done once for every project. The result of this processes can be reused as many times as you want.

You may specify a "progress callback" that the loader may call periodically with progress updates. `type` will be a string like `assets` or `compress`. Depending on the type, `a` might be "loaded" and `b` might be "total", or `a` might be a percent [0-1] in which case `b` is unused.

```js
const progressCallback = (type, a, b) => {};
const loadedProject = await Packager.loadProject(projectData, progressCallback);
```

### Package the project

Now you can make a Packager.

```js
const packager = new Packager.Packager();
packager.project = loadedProject;
```

`packager.options` has a lot of options on it for you to consider. You can log the object or see [packager.js](../src/packager/packager.js) and look for `DEFAULT_OPTIONS` to see what options are available.

We recommend that you avoid overwriting the entirety of `packager.options` as this will cause issues when the structure of the options object changes in future updates. Instead, just update the properties you want to change from the defaults.

```js
// GOOD:
packager.options.turbo = true;
packager.options.custom.js = "/* */";

// BAD (DO NOT DO THIS):
packager.options = {
  turbo: true,
  custom: {
    js: "/* */"
  },
  // ...
};
```

Even if you add `...packager.options` the second example is still broken: `options.custom` also has a `css` property which is accidentally being set to `undefined` which is undefined behavior. Instead of remembering to do `...packager.options.xyz` everywhere, it's best to just avoid completely redefining options whenever possible.

Some options expect an image as an argument. In the Node.js module, there is a special class to use for these, `new Packager.Image(mimeType, buffer)`:

```js
packager.options.app.icon = new Packager.Image('image/png', fs.readFileSync('icon.png'));
```

### Program-specific compilation

Every export jointly links the optimized project and its specialized VM. Node 22.15 or newer is required.

```js
packager.options.compiler.seed = 'reproducible-build';
packager.options.compiler.warpTimer = false;
packager.options.compiler.aggressiveRenaming = false;
```

The seed is optional; an empty seed selects fresh cryptographic random build material. A seed is not a secret or an encryption key.

Enable `packager.options.compiler.aggressiveRenaming = true` (or pass `aggressiveRenaming: true` to `compileProject`) to also rename VM internal fields and runtime, sprite, core block and bundled renderer/Drawable/Skin methods. Coverage includes `isKilled`, thread execution status, `startHats`, `getTargetForStage`, `setXY`, `setSize`, `getCostumes`, and calls such as `runtime.ext_scratch3_motion._moveSteps(10, target)`. The default is `false`. This mode is intended for standard Scratch projects and may break third-party extension compatibility. Native JS/browser APIs, public player/extension APIs, SB3 state keys (`variables`, `currentCostume`) and unrelated string literals remain stable. HTTP response `status` is preserved separately from thread status. `diagnostics.aggressiveProperties` records renamed and reserved candidates; `diagnostics.scopedProperties['Thread.status']` records the thread status mapping. Target instance fields (including `size`, `visible`, `isStage`, `variables` and `currentCostume`) have separate private keys, reported as `diagnostics.scopedProperties['Target.size']` etc.; data loading, cloning and serialization preserve the external SB3 format. Ambiguous receivers use an instance-aware key adapter; proven Target accesses use direct private fields.

To obtain the linked JavaScript and resource archive without a page wrapper:

```js
const {compileProject} = require('@sccn/tw-packager');
const player = await compileProject(fs.readFileSync('project.sb3'), {
  seed: 'reproducible-build',
  autoplay: false
});
fs.writeFileSync('player.js', player.code);
for (const asset of player.assets) fs.writeFileSync(asset.name, asset.data);
```

Load `player.js` with a normal script tag alongside `project.zip`. `player.buildId` identifies the final JavaScript and resource archive; `player.diagnostics` contains capability reasons, retained/removed modules, internal property mappings and continuation groups. `diagnostics.schedulingProperties` lists the audited Thread/Sequencer methods and their final names; `diagnostics.reservedPropertyReasons` explains names retained for dynamic access, reflection or uncertain ownership. Keep diagnostics as development material, outside the player.

Pass `sourceMap: true` to receive a separate `player.sourceMap` object for local debugging. It contains source information and must not be distributed with a protected player. The default result omits it, and neither mode inserts a source-map URL into the code.

The browser exposes a frozen `window.player` with `start`, `stop`, `pause`, `resume`, `postInput(device, data)`, `on(event, callback)`, `off(event, callback)` and `dispose`. Events are `loaded`, `state`, `problem`, and `error`; event payloads contain no VM references. Wait for `loaded` before starting a player with autoplay disabled.

Third-party extensions run in isolated Workers. Supply URLs in `options.extensions`, or `{url, source, dependencies}` objects to `compileProject`; `dependencies` maps absolute code URLs to source strings. Static imports and literal `importScripts` dependencies are frozen during the build. Registration must finish synchronously; block operations may be asynchronous. Extensions requiring full VM access, compiler mutation, dynamic code imports or new runtime extensions fail compilation.

Old `.sb3c`/`.sb3c2` packages, `compiler.aot`, `compiledProjectHooks`, signing/network protection, `bakeExtensions`, custom JavaScript, and unsafe cloud evaluation have been removed. Rebuild from the original SB3 and reset legacy settings. Ordinary cloud variables remain available through the packager's cloud options.

Note that a Packager is a single-use object; you must make a new Packager each time you want to package a project.

Now you can finally actually package the project.

```js
const result = await packager.package();

// Suggested file name including file extension based on packager's options.
// This is not sanitized so it could contain things like path traversal exploits. Be careful.
const filename = result.filename;

// MIME type of the packaged project. Either "text/html" or "application/zip"
const type = result.type;

// The packaged project's data. Will always be a Uint8Array.
const data = result.data;
```

You can also add progress listeners on the packager using something similar to the addEventListener you're familiar with. Note that these aren't actually EventTargets, just a tiny shim that looks similar, so some things like `once` won't work and the events don't have very many properties on them.

```js
// do this before calling package()
packager.addEventListener('zip-progress', ({detail}) => {
  // Used when compressing projects as zips
  console.log('Packager progress zip-progress', detail);
});
packager.addEventListener('large-asset-fetch', ({detail}) => {
  // Used when fetching large assets such as Electron binaries
  console.log('Packager progress large-asset-fetch', detail);
});
```

What you do with `data` is now entirely up to you.

Be mindful of the copyright on the projects you package.
