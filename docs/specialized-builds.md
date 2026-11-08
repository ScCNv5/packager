# Program-specific player builds

`compileProject` now returns `{code, assets, buildId, diagnostics}`. There is no compiled package loader in the production player. HTML, ZIP and desktop wrappers consume the same linked VM/program source; resources contain initial state and assets, not executable scripts. The ordinary VM compiler remains available for development and differential tests.

## Build implementation

1. `scratch-vm.exportSpecializedProjectBuildInput()` exports optimized structured IR, event descriptors, initial project state and extension requirements. Export also extracts gamepad hints before deleting source blocks and comments.
2. `scratch-vm/src/compiler/continuation.js` lowers the IR directly. It reuses the existing typed expression and atomic operation emitters. Calls, returns and waits save per-thread continuations; compatible warp loops stay structured, including bounded inlining of synchronous, acyclic warp calls. Terminal void warp calls reuse frames; arguments that can suspend still spill in evaluation order. Straight-line yielding loops use one resume region. It never parses old factory strings.
3. `scripts/prepare-runtime-sources.mjs` prepares resolved ESM modules from the locked sibling VM and dependencies. First-party CommonJS is converted before linking. Runtime, Thread and Sequencer have production definitions with the editor/compiler entry paths removed. The generated source pack is a build-tool asset, never a player asset.
4. `src/specialized/link.mjs` replaces Sequencer's step method with shared dispatch methods and emits static hat/primitive entries. Each group contains at most 256 regions with a 12,000-character input-code budget; an indivisible native loop may exceed that budget. Groups are actual separate VM methods. Encoded group/local PCs let both dispatch levels use jump tables. Iteration crosses groups without introducing a yield. Slot permutations and declared internal property names use the same build seed. Pure synchronous regions cache proven VM variable references/values and commit before runtime exits and on exceptions; calls that can observe VM state prevent this optimization.
5. Rollup links the player from memory, then joint property transformation and Terser compression run on the combined result. Both browser Worker and Node use this implementation. The standalone builder embeds the source pack, Rollup and parser WASM; it also works from a local HTML file without network access.

The implementation renames the explicitly owned continuation, lifecycle, worker and target-identity fields in both VM and generated code. The scheduling manifest also covers three Sequencer methods (`stepThread`, `stepThreads`, `retireThread`) and eleven Thread stack/identity methods. Build-only annotations bind the actual classes and monitor-execution parameters across Rollup; they are removed before the player is emitted. The audit follows immutable aliases, destructuring and optional member accesses. Literal reflection, dynamic access through known scheduling receivers, reassigned aliases, unrelated declarations and unproven receivers reserve the affected names. `diagnostics.schedulingProperties` reports each scheduling method's mapping or reservation; `diagnostics.reservedPropertyReasons` explains reservations. Missing owner methods or changed parameter/static/async/generator signatures fail the build until the manifest is reviewed.

This is a bounded scheduling audit, not whole-program ownership inference. Ambiguous legacy fields such as `status`, `target`, `runtime` and `value`, host APIs and extension RPC fields keep stable names. The boundary is recorded in `diagnostics.propertyBoundary`; future expansion requires additional ownership/escape analysis. With `sourceMap: true`, `compileProject` returns a separate `sourceMap` object. Property/slot maps and analysis are separate return data. None are embedded in the player; enabling maps does not change its code.

Capabilities are selected from emitted operations, assets, hats, monitors and extensions. Unused sound, video and pen modules are removed. Builtin block classes retain only referenced methods, transitive helpers and initialization. Builtin extensions with static registration metadata are pruned by required opcodes and direct IR calls. Dynamic registration metadata conservatively retains its extension as a unit. `diagnostics` lists retained and removed modules/members, capability reasons, shared dispatch groups, fixed-extension dependencies and surviving third-party CommonJS wrappers.

The optional `aggressiveRenaming` build option (or `packager.options.compiler.aggressiveRenaming`) defaults to `false`. It extends the shared seeded property map to methods and internal fields collected from the prepared Runtime, Thread, Sequencer, Target, RenderedTarget, Sprite, Variable, core block classes and the bundled Scratch Render classes (including Drawable and Skin). This includes core module entry fields (`ext_scratch3_*`), private helpers, public sprite methods (`setXY`, `setSize`, `setCostume`, `getCostumes`, `isTouchingObject`), runtime methods (`startHats`, `getTargetForStage`) and thread fields such as `isKilled`. Definitions, initialization, compiled calls and monitor code use the same mapping.

Thread `status` is normalized to an internal field before linking in an explicit source-module/receiver manifest, including the pause addon's saved state. Unexpected status receivers fail the build for review. HTTP `Response.status` and other external status fields retain their names. `diagnostics.scopedProperties['Thread.status']` reports the internal field's final name.

The source pack includes the pinned Terser platform-property inventory, covered by its fingerprint. Native JS/browser APIs, the frozen player API, extension registration/RPC shapes and SB3 state keys remain stable. External JSON keys such as `variables`, `currentCostume`, `size` and `visible` remain unchanged; Target instance state uses separate private keys. `value` remains stable. String literals (including literal property access and reflection keys) also reserve names. This mode targets standard Scratch projects and may break third-party extension compatibility. `diagnostics.aggressiveRenaming` records the mode; `diagnostics.aggressiveProperties` lists candidate mappings and reservation reasons. Regenerate old source packs before using this expanded mode.

Target state conversion brands the production Target prototype once with a private, non-enumerable Symbol. The linker rewrites instance access, writes, destructuring and literal property checks; proven Target accesses use direct private fields, and ambiguous receivers use a small owned-instance key adapter. JSON objects, DOM events, Maps, renderer records and external option objects retain their own keys. The adapter preserves receiver evaluation and method-call binding, and introduces no legacy property getters on Target. Clones inherit the brand without per-instance registration; serialization emits the original SB3 keys. Unsupported new destructuring or optional-chain source shapes fail compilation for review. `diagnostics.scopedProperties['Target.size']` (and the other Target fields) reports each private name; `diagnostics.targetStateAccesses` records direct and adapted access counts. This is still client-side obfuscation: the adapter's external key list is observable and can be analyzed.

The wrapper allowlist contains only JSZip's `utils.js`/`base64.js` cycle, whose `require` bindings capture partially initialized mutable export objects. Their source hashes, dependency cycle and initialization reason are recorded in the build report; source changes require a fresh review. Player-only ZIP preparation excludes Node stream adapters and obsolete Promise polyfills. Text utility module closures are converted to ESM. TWGL 4.4.0's pinned 15-module acyclic webpack bundle is unpacked into ESM at build-tool preparation time, removing its factory table and loader. Both transformations check their source shape, and the TWGL transform checks its exact source hash. CommonJS uses the explicit allowlist, rather than automatic conditional-require wrapping. Any surviving unaudited wrapper fails the build.

## Playback API

The only global integration object is frozen `window.player`:

```js
player.on('loaded', () => player.start());
player.on('error', ({message}) => console.error(message));
player.postInput('keyboard', {key: 'a', isDown: true});
player.pause();
player.resume();
player.stop();
player.dispose();
```

The complete method set is `start`, `stop`, `pause`, `resume`, `postInput`, `on`, `off`, `dispose`. Event types are `loaded`, `state`, `problem`, `error`. Device inputs accept scalar keyboard, mouse, mouse-wheel and user-data fields. Event payloads do not expose VM/Thread references. Disposal terminates extension Workers, closes audio/video/cloud resources and removes player/addon input listeners.

Promise continuations capture the thread's lifetime object. Stopping, retiring or restarting a thread invalidates it. Promise completion during pause does not bypass the pause scheduler. The implementation never falls back to the old compiled-package protection chain.

## Extensions and compatibility

Builtin extensions are selected from project requirements. Third-party code is frozen from build-time URLs or supplied `{url, source, dependencies}` entries. Dependency keys are absolute URLs. Static ESM imports and literal `importScripts` calls are recursively resolved during the build. No extension code is resolved from a CDN by the player. Data-fetching blocks and normal cloud variables can still use the network as part of project behavior.

Third-party extensions register synchronously in an isolated Worker; their block operations may return Promises and branch indices. Metadata is collected separately during compilation and checked again during playback. Node metadata collection uses a separate permission-restricted process and a context with dynamic code generation disabled. Runtime extension Workers receive no VM or compiler objects. Dynamic registration/loading, compiler mutation, unsandboxed VM access and runtime code evaluation are rejected.

Old `.sb3c`/`.sb3c2` packages require the original SB3 for rebuilding. Old `compiler.aot`, `compiledProjectHooks`, signature/network-protection settings, `bakeExtensions`, custom JavaScript and unsafe cloud evaluation no longer have implementation paths. Loading legacy settings reports migration and resets incompatible fields. Custom CSS and normal cloud providers remain supported.

## Validation

```sh
npm ci
npm run build-node
npm test -- --runInBand
npm run test:specialized
node --test test/specialized-structure.mjs
node --test test/specialized-properties.mjs
npm run test:specialized-aggressive
node test/specialized-build.mjs
node test/specialized-worker-input.mjs
node test/specialized-browser.mjs
node test/specialized-performance.mjs
node test/specialized-performance.mjs --aggressive
npm run build-standalone
node test/specialized-standalone.mjs
```

Playwright's Chromium, Firefox and WebKit binaries must be installed for browser tests. Build/performance artifacts go to the sibling `work/acceptance` directory and are not published. Use Node 22.15 or newer. The lockfile pins the Node and browser Rollup versions; the WASM bootstrap patch deliberately fails if that pinned entry changes.

To exercise aggressive mode through the public Node API, HTML/ZIP packaging, real browser playback and browser Worker parity, run `node test/specialized-build.mjs --aggressive` and `node test/specialized-worker-input.mjs --aggressive` before `node test/specialized-browser.mjs`. These regenerate the local acceptance artifacts for the selected mode.

CI checks out both repositories as siblings. Set the `SPECIALIZED_VM_REF` repository variable to the full commit SHA containing the matching VM changes; workflows reject an absent or floating revision. No commit is invented or automatically pushed by local builds. `node test/specialized-differential.mjs --linked` runs the same fixture comparison against the complete linked/pruned/renamed production VM, in addition to the faster continuation-only harness.

The execution harness covers all 112 existing VM fixtures and compares variables, lists and SAY event order with JS AOT. The linked variant also exercises serialization, pruning and joint transformation; it caught headless target-layer loss and inline legacy primitive registration, both corrected in the implementation. Separate lifecycle tests cover stale Promise completions after stop/restart and completion during pause. Artifact tests reject direct/aliased/computed dynamic evaluation, runtime imports and generators, and inspect source removal, capability removal, seed determinism and dispatch structure. Browser tests prohibit JavaScript dynamic evaluation and exercise playback, API isolation, async extensions, actual WebGL pen pixels and Node/Worker byte equality.

The performance harness measures the actual jointly linked VM in the same JS realm as JS AOT, after three warmups and over five measured rounds. It records medians, nearest-rank p95, linked-player startup, build time and process heap. Its 10% median CPU regression gate fails the test on regression. These CPU fixtures cover arithmetic, warp procedure calls among cold scripts, lists, broadcasts, clones and pen state updates. **Passing these small fixtures does not establish real-project performance parity. GPU drawing, per-player peak memory and native desktop startup on every supported OS remain separate release gates.** An additional renderer trace test compares movement, effects and pen operations; an actual dispatcher substitution test rejects a dispatcher from another build and verifies that both original builds preserve behavior. Broader renderer scenarios remain part of project-level regression testing.

The actual macOS WebView archive has been built and its executable launched. GUI capture was unavailable in the test host (ScreenCaptureKit error -3811), so native visual playback has not been claimed. Windows/Linux native launch remains to be checked on those platforms. The offline standalone builder was exercised from `file://` with networking disabled, including generating and playing its downloaded HTML.

### Initial local acceptance recorded on 2026-09-03 (limited fixture scope)

- Continuation differential: 112/112 existing fixtures passed. Final complete linked-player differential: 112/112 passed across three isolated process shards (38 + 37 + 37). `--shard=0/3` through `--shard=2/3` partition the sorted fixture list without sharing VM globals.
- Lifecycle, structure and renderer trace: 7/7 tests passed. Existing package tests: 54 passed, one pre-existing skip. Modified VM files passed ESLint; both repositories passed `git diff --check`.
- Chromium, Firefox and WebKit each passed bare player, embedded HTML, web ZIP, fixed asynchronous extension/branch, actual pen pixels and Node/Worker byte parity checks. Offline standalone UI construction and playback passed.
- Final five-round median CPU changes relative to JS AOT: arithmetic -9.4%, lists +1.6%, broadcasts -56.1%, clones -47.1%, pen state updates -13.3%. All met the +10% gate. Startup timing excludes writing the test artifact to disk. The scope exclusions above still apply.
- Production Node build and package dry-run passed; the package contains the prepared linker and excludes obsolete Scaffolding API documentation and duplicate intermediate source packs. CI configuration was syntax-checked locally; remote CI/deployment was not run.

### Real-project regression: Scratch Benchmark 441947766

The reported computation score was 2060 versus 36233 in TurboWarp. The original tiny-loop gate missed this regression: it did not exercise a large program with frequently called warp procedures. The old backend split non-suspending calls into frames and put all switch groups in one oversized function. On the original workload procedures, the initial same-realm reproduction measured roughly 10x execution time for terrain generation and 9x for raycasting.

The corrections above retain structured computation, remove unused inlined procedure regions, split actual dispatcher methods and reduce frame/variable lookup overhead. This is still **not a completed +10% real-project release gate**. In the final five-round Node 26.7.0 check with seed `scratch-benchmark`, median execution-time changes were PRNG -14.9%, terrain -49.6%, raycasting +32.7%, quicksort -1.5%, list search +4.8% and string parsing -8.7%. All workload states matched, but raycasting failed the gate. Node 24 and Node 26 differ, so results must include the engine and seed. Earlier fixture-only performance numbers must not be generalized to all projects. Browser automation policy blocked opening the preview during this investigation; updated full-browser scores have not been verified.

After these corrections, the complete linked-player differential passed 112/112 fixtures, and lifecycle/structure/renderer checks passed 7/7 tests. The six smaller performance fixtures also passed, including the added million-iteration warp-call loop among 80 cold scripts. Prepared browser Worker/linker resources and the Node bundle were rebuilt. Existing exported HTML files must be rebuilt to receive the changes.

The subsequent scheduling-renaming expansion passed the complete linked differential again (112/112), 18 lifecycle/structure/rendering/property tests, and 61 package tests (one existing skip). The property suite includes linked pause/resume/stop integration and rejection of changed owner signatures. Artifact checks confirmed all 14 scheduling names are mapped in the plain and fixed-extension fixtures, with no ownership markers in the player. Node and browser Worker/linker resources were rebuilt; this follow-up was validated through Node, not a new browser run.

In a sequential before/after run on Node 26.7.0 with seed `scratch-benchmark`, three warmups and five measured rounds, the renamed player's CPU time relative to JS AOT was PRNG -14.9%, terrain -46.4%, raycasting +29.9%, quicksort +2.1%, list search +3.9% and string parsing -7.0%. All six workload states matched. Relative to the signed checkpoint, its own workload medians changed between -4.4% and +8.5%; this is a bounded regression check, not evidence of a stable speedup. In particular, raycasting's absolute median changed from 0.6254 ms to 0.6412 ms even though its ratio to AOT improved from +38.6% to +29.9%. The real-project gate remains failed; the six small performance fixtures passed. Scheduling renaming does not resolve the remaining dispatch overhead.

Run the additional gate using the original SB3 downloaded from [Scratch Benchmark](https://scratch.mit.edu/projects/441947766/):

```sh
npm run test:specialized-scratch-benchmark -- /path/to/original.sb3 ../work/acceptance/scratch-benchmark-report.json scratch-benchmark
```

The runner retains the full program in the final linked/minified code, invokes the original CPU workload procedures, compares resulting variables/lists, alternates AOT/specialized measurement order, and records source/code hashes, seed, engine, five sample sets and p95. It excludes the project's wall-clock score calculation, graphics, assets and cloud I/O. It exits unsuccessfully when any workload exceeds +10%; there is no fallback to the old protection chain. `BENCH_PROFILE=1` additionally writes an independent CPU profile, code and property map next to the report for development.
