const loadDependencies = async () => {
  const [vmModule, storageModule, protection] = await Promise.all([
    import(/* webpackChunkName: "compiled-project-builder" */ 'scratch-vm'),
    import(/* webpackChunkName: "compiled-project-builder" */ '@turbowarp/scratch-storage'),
    import(/* webpackChunkName: "compiled-project-protection" */ 'sb3c-vm-obfuscator')
  ]);
  return {
    VM: vmModule.default || vmModule,
    Storage: storageModule.default || storageModule,
    protection
  };
};

const configureExtensionSecurity = (vm) => {
  const securityManager = vm.extensionManager && vm.extensionManager.securityManager;
  if (!securityManager) return;
  securityManager.getSandboxMode = () => 'unsandboxed';
  securityManager.canLoadExtensionFromProject = () => true;
};

const loadJavaScriptObfuscator = async supplied => {
  if (supplied) return supplied.default || supplied;
  const imported = await import(
    /* webpackChunkName: "compiled-project-debug-protection" */ 'javascript-obfuscator'
  );
  return imported.default || imported;
};

/**
 * Create one player-level anti-debugging script. Applying debug protection to
 * each compiled factory would duplicate guards and timer loops in every
 * procedure, so it is intentionally separated from factory obfuscation.
 * @param {object} options debug protection options
 * @param {number} [options.interval=0] repeat interval in milliseconds; 0 disables repetition
 * @param {object} [implementation] injected javascript-obfuscator implementation
 * @returns {object} protection stage
 */
export const createGlobalDebugProtectionStage = (options = {}, implementation) => ({
  id: 'tw-packager-global-debug-protection',
  version: 1,
  kind: 'runtime-sidecar',
  mutatesFactories: false,
  async transform ({artifact, seed}) {
    const interval = Number(options.interval || 0);
    if (!Number.isFinite(interval) || interval < 0 || (interval > 0 && interval < 1000)) {
      throw new Error('debugProtectionInterval must be 0 or at least 1000 milliseconds');
    }
    const obfuscator = await loadJavaScriptObfuscator(implementation);
    if (!obfuscator || typeof obfuscator.obfuscate !== 'function') {
      throw new Error('Invalid javascript-obfuscator implementation');
    }
    const result = obfuscator.obfuscate('void 0;', {
      compact: true,
      debugProtection: true,
      debugProtectionInterval: interval,
      renameGlobals: false,
      renameProperties: false,
      seed,
      selfDefending: Boolean(options.selfDefending),
      sourceMap: false,
      target: 'browser'
    });
    return {
      artifact,
      sidecars: [{
        name: 'debug-protection.js',
        mediaType: 'text/javascript',
        content: result.getObfuscatedCode(),
        execution: 'global-script'
      }],
      diagnostics: {interval}
    };
  }
});

const getJavaScriptObfuscatorOptions = aot => {
  const configured = {...(aot.javascriptObfuscatorOptions || {})};
  const encoding = configured.stringArrayEncoding;
  if (typeof encoding === 'string') {
    configured.stringArrayEncoding = encoding === 'none' ? [] : [encoding];
  }
  delete configured.debugProtection;
  delete configured.debugProtectionInterval;
  return configured;
};

/**
 * Compile and optionally protect a project before it is embedded in a packaged application.
 * @param {ArrayBuffer|Uint8Array} projectData original project bytes
 * @param {object} options compiler options
 * @param {object} [hooks] non-serializable build hooks for advanced callers
 * @param {Function} [hooks.seedMaterial] public seed material selector
 * @param {Function} [hooks.deriveSeed] local or remote seed provider
 * @param {Function} [hooks.signManifest] integrity manifest signer
 * @param {object} [hooks.javascriptObfuscatorOptions] javascript-obfuscator options
 * @param {Array<object>} [hooks.stages] custom protection stages
 * @param {object} [dependencies] injected dependencies for tests
 * @returns {Promise<object>} compiled package, accessor sidecar, and diagnostics
 */
export const compileProject = async (projectData, options, hooks = {}, dependencies) => {
  const {VM, Storage, protection} = dependencies || await loadDependencies();
  const vm = new VM();
  vm.attachStorage(new Storage());
  configureExtensionSecurity(vm);
  vm.setCompilerOptions({enabled: true, warpTimer: Boolean(options.warpTimer)});

  try {
    await vm.loadProject(projectData);
    const aot = options.aot;
    let artifact = vm.exportCompiledProject();
    let sidecars = [];
    let diagnostics = {stages: []};

    if (aot.obfuscate || aot.javascriptObfuscator || hooks.stages) {
      const configuredObfuscatorOptions = {
        ...getJavaScriptObfuscatorOptions(aot),
        ...(hooks.javascriptObfuscatorOptions || {})
      };
      const debugProtection = Boolean(
        (aot.javascriptObfuscatorOptions && aot.javascriptObfuscatorOptions.debugProtection) ||
        configuredObfuscatorOptions.debugProtection
      );
      const debugProtectionInterval = configuredObfuscatorOptions.debugProtectionInterval !== undefined ?
        configuredObfuscatorOptions.debugProtectionInterval :
        (aot.javascriptObfuscatorOptions && aot.javascriptObfuscatorOptions.debugProtectionInterval);
      delete configuredObfuscatorOptions.debugProtection;
      delete configuredObfuscatorOptions.debugProtectionInterval;
      const stages = hooks.stages || [
        ...(aot.obfuscate ? [protection.createVmAccessStage({
          accessorName: aot.accessorName,
          shortIds: aot.shortIds
        })] : []),
        ...(aot.javascriptObfuscator ? [protection.createJavaScriptObfuscatorStage({
          options: configuredObfuscatorOptions
        })] : []),
        ...(aot.javascriptObfuscator && debugProtection ? [
          createGlobalDebugProtectionStage({
            interval: debugProtectionInterval,
            selfDefending: configuredObfuscatorOptions.selfDefending
          })
        ] : [])
      ];
      const protectOptions = {stages};
      if (hooks.seedMaterial) protectOptions.seedMaterial = hooks.seedMaterial;
      if (hooks.deriveSeed) {
        protectOptions.deriveSeed = hooks.deriveSeed;
      } else if (aot.seed) {
        protectOptions.deriveSeed = () => ({
          seed: aot.seed,
          derivationId: 'tw-packager-explicit-v1'
        });
      }
      const result = await protection.protectCompiledProject(
        vm.exportCompiledProjectBuildInput(),
        protectOptions
      );
      artifact = result.artifact;
      sidecars = result.sidecars;
      diagnostics = result.diagnostics;
    }

    const packageData = await vm.saveCompiledProject('arraybuffer', {
      artifact,
      integrity: hooks.signManifest ? {signManifest: hooks.signManifest} : {}
    });
    const accessorSidecar = sidecars.find(sidecar => sidecar.bindingName) || null;
    return {packageData, artifact, accessorSidecar, sidecars, diagnostics};
  } finally {
    vm.quit();
  }
};

export default compileProject;
