import {compileProject, validateBuildOptions} from '../../src/packager/compile-project';

test.each(['aot', 'signManifest', 'deriveSeed', 'stages', 'signatureVerifierSource', 'wasm', 'protection'])(
  'old %s options report migration instead of being ignored', async key => {
    await expect(compileProject(new Uint8Array(), {[key]: false})).rejects.toThrow('原始 SB3');
  }
);
test('the production compiler cannot be disabled', () => {
  expect(() => validateBuildOptions({enabled: false})).toThrow('必须启用编译');
});
test('seed, warp timing and aggressive renaming remain explicit build options', () => {
  expect(() => validateBuildOptions({seed: 'reproducible', warpTimer: true, aggressiveRenaming: true})).not.toThrow();
});
test.each(['true', 1, null])('invalid aggressive renaming value %p is rejected', aggressiveRenaming => {
  expect(() => validateBuildOptions({aggressiveRenaming})).toThrow('aggressiveRenaming must be a boolean');
});
