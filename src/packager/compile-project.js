import {Adapter} from './adapter';
import sha256 from './sha256';
import {facadeSource} from '../specialized/facade';

export const migrationError = () => new Error('旧编译包和保护选项已移除。请使用原始 SB3 重新构建，并重置旧保护设置。');
export function validateBuildOptions(options = {}) {
  if (['aot', 'signManifest', 'deriveSeed', 'stages', 'signatureVerifierSource', 'wasm', 'protection'].some(key => key in options)) throw migrationError();
  if (options.enabled === false) throw new Error('专用播放器必须启用编译。');
}
export function validatePackagerOptions(options = {}) {
  validateBuildOptions(options);
  validateBuildOptions(options.compiler || {});
  if ('bakeExtensions' in options || 'compiledProjectHooks' in options || options.custom && options.custom.js ||
    options.cloudVariables && options.cloudVariables.unsafeCloudBehaviors) throw migrationError();
}
const randomSeed = () => {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, x => x.toString(16).padStart(8, '0')).join('');
};
const seedNumber = seed => {
  let hash = 2166136261;
  for (const char of String(seed)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};
export async function rejectLegacyProject(data) {
  const bytes = new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const {default: JSZip} = await import(/* webpackChunkName: "jszip" */ '@turbowarp/jszip');
    const archive = await JSZip.loadAsync(bytes);
    if (Object.keys(archive.files).some(name => /(^|\/)(compiled-project(?:\.integrity)?\.json|program\.wasm|effects\.wasm)$/.test(name))) throw migrationError();
  } else if (/scratch-vm-compiled-project/.test(new TextDecoder().decode(bytes.subarray(0, 512)))) throw migrationError();
}

// Internal build input never becomes a runtime-loadable compilation artifact.
export async function prepareProject(projectData, options = {}) {
  validateBuildOptions(options);
  await rejectLegacyProject(projectData);
  const [vmModule, storageModule, lowering, zipModule] = await Promise.all([
    import(/* webpackChunkName: "project-frontend" */ 'scratch-vm'),
    import(/* webpackChunkName: "project-frontend" */ '@turbowarp/scratch-storage'),
    import(/* webpackChunkName: "project-frontend" */ 'scratch-vm/src/compiler/continuation'),
    import(/* webpackChunkName: "jszip" */ '@turbowarp/jszip')
  ]);
  const JSZip = zipModule.default || zipModule;
  const bytes = new Uint8Array(projectData.buffer || projectData, projectData.byteOffset || 0, projectData.byteLength);
  const VM = vmModule.default || vmModule;
  const Storage = storageModule.default || storageModule;
  const vm = new VM();
  vm.attachStorage(new Storage());
  vm.setCompilerOptions({enabled: true, warpTimer: Boolean(options.warpTimer)});
  vm.extensionManager.securityManager.getSandboxMode = () => 'worker';
  vm.extensionManager.securityManager.canLoadExtensionFromProject = () => true;
  const seed = options.seed === undefined || options.seed === '' ? randomSeed() : String(options.seed);
  const fixedExtensions = [];
  const requests = new Map();
  const loadExtension = vm.extensionManager.loadExtensionURL.bind(vm.extensionManager);
  vm.extensionManager.loadExtensionURL = url => {
    if (vm.extensionManager.isBuiltinExtension(url)) return loadExtension(url);
    if (requests.has(url)) return requests.get(url);
    const request = (async () => {
      const supplied = (options.extensions || []).find(item => typeof item === 'object' && item.url === url);
      const sources = {...(supplied && supplied.dependencies || {})};
      sources[url] = supplied && supplied.source !== undefined ? supplied.source : await Adapter.fetchExtensionScript(url);
      let frozen;
      for (;;) {
        try { frozen = await Adapter.prepareExtension({url, sources}); break; }
        catch (error) {
          const missing = error.missingDependency;
          if (!missing || Object.hasOwn(sources, missing)) throw error;
          if (!/^(https?:|data:)/.test(missing)) throw new Error(`Unsupported extension dependency URL: ${missing}`);
          sources[missing] = await Adapter.fetchExtensionScript(missing);
        }
      }
      const infos = await Adapter.inspectExtension(frozen.code);
      const digest = await sha256(new TextEncoder().encode(frozen.code));
      const token = `fixed:${digest}`;
      for (const info of infos) {
        if (vm.extensionManager.isExtensionLoaded(info.id)) throw new Error(`Duplicate fixed extension ID: ${info.id}`);
        const proxy = {getInfo: () => JSON.parse(JSON.stringify(info))};
        for (const block of info.blocks || []) if (block && typeof block === 'object' && block.opcode) {
          proxy[block.func || block.opcode] = () => { throw new Error('Extension execution is unavailable during IR analysis'); };
        }
        const service = vm.extensionManager._registerInternalExtension(proxy);
        vm.extensionManager._loadedExtensions.set(info.id, service);
      }
      fixedExtensions.push({token, infos, code: frozen.code, dependencies: frozen.dependencies});
    })();
    requests.set(url, request);
    return request;
  };
  try {
    for (const extension of options.extensions || []) await vm.extensionManager.loadExtensionURL(typeof extension === 'string' ? extension : extension.url);
    await vm.loadProject(bytes);
    const input = vm.exportSpecializedProjectBuildInput();
    input.fixedExtensions = fixedExtensions.sort((a, b) => a.token.localeCompare(b.token));
    input.project.extensionURLs = {};
    for (const extension of fixedExtensions) for (const info of extension.infos) input.project.extensionURLs[info.id] = extension.token;
    input.project.extensions = [...new Set([...(input.project.extensions || []), ...Object.keys(input.project.extensionURLs)])].sort();
    const program = (lowering.lower || lowering.default.lower)(input, seedNumber(seed));
    const assets = vm.serializeAssets().map(asset => ({name: asset.fileName, data: asset.fileContent}));
    const archive = new JSZip();
    const date = new Date('2000-01-01T00:00:00Z');
    archive.file('project.json', JSON.stringify(input.project), {date});
    for (const asset of [...assets].sort((a, b) => a.name.localeCompare(b.name))) archive.file(asset.name, asset.data, {date});
    const resourceData = await archive.generateAsync({type: 'uint8array', compression: 'DEFLATE', compressionOptions: {level: 6}});
    return {input, program, seed, assets, resourceData};
  } finally { vm.quit(); }
}

export async function finishProject(prepared, boot, options = {}) {
  if (!Adapter || !Adapter.linkSpecialized) throw new Error('Specialized build adapter is unavailable');
  const linked = await Adapter.linkSpecialized({input: prepared.input, program: prepared.program,
    seed: prepared.seed, boot, addons: options.addons || {}, minifyOutput: options.minify !== false, sourceMap: options.sourceMap === true});
  const codeHash = await sha256(new TextEncoder().encode(linked.code));
  const resourceHash = await sha256(prepared.resourceData);
  const buildId = await sha256(new TextEncoder().encode(JSON.stringify({codeHash, resourceHash})));
  return {code: linked.code, assets: [{name: 'project.zip', data: prepared.resourceData}], buildId,
    ...(linked.sourceMap ? {sourceMap: linked.sourceMap} : {}),
    diagnostics: {...linked.diagnostics, seed: prepared.seed, codeHash, resourceHash}};
}

/** Build one program/VM code unit and its source-free resources. */
export async function compileProject(projectData, options = {}) {
  const prepared = await prepareProject(projectData, options);
  const boot = `const scaffolding = new Scaffolding.Scaffolding();
    scaffolding._root.style.height = '100vh';
    scaffolding.setup(); scaffolding.appendTo(document.body);
    const vm = scaffolding.vm;
    ScaffoldingAddons.run(scaffolding, {pause: true});
    ${facadeSource}
    (async () => {
      const response = await fetch('./project.zip');
      if (!response.ok) throw new Error('Could not load player resources');
      const zip = await Scaffolding.JSZip.loadAsync(await response.arrayBuffer());
      scaffolding.storage.addHelper({load: async (type, id, format) => {
        const file = zip.file(id + '.' + format);
        return file ? scaffolding.storage.createAsset(type, format, await file.async('uint8array'), id) : null;
      }});
      await scaffolding.loadProject(await zip.file('project.json').async('string'));
      playerLoaded();
      ${options.autoplay === false ? '' : 'window.player.start();'}
    })().catch(playerError);`;
  return finishProject(prepared, boot, {...options, addons: {pause: true}});
}
export default compileProject;
