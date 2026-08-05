import {
  compileProject,
  createGlobalDebugProtectionStage
} from '../../src/packager/compile-project';

const makeDependencies = () => {
  const calls = {};
  class VM {
    constructor () {
      calls.vm = this;
    }

    attachStorage (storage) {
      calls.storage = storage;
    }

    setCompilerOptions (options) {
      calls.compilerOptions = options;
    }

    loadProject (data) {
      calls.projectData = data;
      return Promise.resolve();
    }

    exportCompiledProject () {
      return {format: 'scratch-vm-compiled-project', requiredBindings: []};
    }

    exportCompiledProjectBuildInput () {
      return {artifact: this.exportCompiledProject(), project: {targets: []}};
    }

    saveCompiledProject (type, options) {
      calls.save = {type, options};
      return Promise.resolve(new ArrayBuffer(4));
    }

    quit () {
      calls.quit = true;
    }
  }
  class Storage {}
  const protection = {
    createVmAccessStage: jest.fn(options => ({id: 'vm-access', options})),
    createJavaScriptObfuscatorStage: jest.fn(options => ({id: 'javascript', options})),
    protectCompiledProject: jest.fn(async (input, options) => {
      calls.protect = {input, options};
      return {
        artifact: {...input.artifact, requiredBindings: ['__vmAccess']},
        sidecars: [{
          name: 'vm-accessor.mjs',
          bindingName: '__vmAccess',
          mediaType: 'text/javascript',
          content: 'export const accessor = {};'
        }],
        diagnostics: {stages: []}
      };
    })
  };
  return {calls, dependencies: {VM, Storage, protection}};
};

test('compileProject applies ordered protection stages and packages the external artifact', async () => {
  const {calls, dependencies} = makeDependencies();
  const signManifest = jest.fn();
  const result = await compileProject(new Uint8Array([1, 2, 3]), {
    warpTimer: true,
    aot: {
      obfuscate: true,
      javascriptObfuscator: true,
      shortIds: true,
      accessorName: '__vmAccess',
      seed: 'release-seed'
    }
  }, {
    signManifest,
    javascriptObfuscatorOptions: {compact: true}
  }, dependencies);

  expect(calls.compilerOptions).toEqual({enabled: true, warpTimer: true});
  expect(calls.protect.options.stages.map(stage => stage.id)).toEqual(['vm-access', 'javascript']);
  expect(calls.protect.options.deriveSeed()).toEqual({
    seed: 'release-seed',
    derivationId: 'tw-packager-explicit-v1'
  });
  expect(calls.save.type).toBe('arraybuffer');
  expect(calls.save.options.artifact.requiredBindings).toEqual(['__vmAccess']);
  expect(calls.save.options.integrity.signManifest).toBe(signManifest);
  expect(result.accessorSidecar.bindingName).toBe('__vmAccess');
  expect(calls.quit).toBe(true);
});

test('compileProject can create an unobfuscated compiled package', async () => {
  const {calls, dependencies} = makeDependencies();
  const result = await compileProject(new ArrayBuffer(0), {
    warpTimer: false,
    aot: {
      obfuscate: false,
      javascriptObfuscator: false,
      shortIds: true,
      accessorName: '__vmAccess',
      seed: ''
    }
  }, {}, dependencies);

  expect(dependencies.protection.protectCompiledProject).not.toHaveBeenCalled();
  expect(calls.save.options.artifact.requiredBindings).toEqual([]);
  expect(result.accessorSidecar).toBe(null);
  expect(calls.quit).toBe(true);
});

test('compileProject can apply JavaScript obfuscation without the VM accessor stage', async () => {
  const {calls, dependencies} = makeDependencies();
  await compileProject(new ArrayBuffer(0), {
    warpTimer: false,
    aot: {
      obfuscate: false,
      javascriptObfuscator: true,
      shortIds: true,
      accessorName: '__vmAccess',
      seed: ''
    }
  }, {}, dependencies);

  expect(calls.protect.options.stages.map(stage => stage.id)).toEqual(['javascript']);
  expect(dependencies.protection.createVmAccessStage).not.toHaveBeenCalled();
});

test('debug protection is a single global stage and is not duplicated in factory options', async () => {
  const {calls, dependencies} = makeDependencies();
  await compileProject(new ArrayBuffer(0), {
    warpTimer: false,
    aot: {
      obfuscate: true,
      javascriptObfuscator: true,
      shortIds: true,
      accessorName: '__vmAccess',
      seed: '',
      javascriptObfuscatorOptions: {
        debugProtection: true,
        debugProtectionInterval: 3000,
        selfDefending: true
      }
    }
  }, {}, dependencies);

  expect(calls.protect.options.stages.map(stage => stage.id)).toEqual([
    'vm-access',
    'javascript',
    'tw-packager-global-debug-protection'
  ]);
  const factoryOptions = dependencies.protection.createJavaScriptObfuscatorStage.mock.calls[0][0].options;
  expect(factoryOptions.debugProtection).toBeUndefined();
  expect(factoryOptions.debugProtectionInterval).toBeUndefined();
});

test('global debug protection stage emits one executable sidecar', async () => {
  const obfuscate = jest.fn(() => ({getObfuscatedCode: () => 'protected();'}));
  const stage = createGlobalDebugProtectionStage({interval: 2500, selfDefending: true}, {obfuscate});
  const artifact = {format: 'scratch-vm-compiled-project'};
  const result = await stage.transform({artifact, seed: 'derived-seed'});

  expect(obfuscate).toHaveBeenCalledWith('void 0;', expect.objectContaining({
    debugProtection: true,
    debugProtectionInterval: 2500,
    selfDefending: true,
    seed: 'derived-seed'
  }));
  expect(result.artifact).toBe(artifact);
  expect(result.sidecars).toEqual([expect.objectContaining({
    name: 'debug-protection.js',
    execution: 'global-script',
    content: 'protected();'
  })]);
});

test('compileProject always disposes the compiler VM after failure', async () => {
  const {calls, dependencies} = makeDependencies();
  dependencies.protection.protectCompiledProject.mockRejectedValueOnce(new Error('stage failed'));
  await expect(compileProject(new ArrayBuffer(0), {
    warpTimer: false,
    aot: {
      obfuscate: true,
      javascriptObfuscator: false,
      shortIds: true,
      accessorName: '__vmAccess',
      seed: ''
    }
  }, {}, dependencies)).rejects.toThrow('stage failed');
  expect(calls.quit).toBe(true);
});
