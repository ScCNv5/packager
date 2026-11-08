import {get} from 'svelte/store';
import {Blob} from 'buffer';
import writablePersistentStore from '../../src/p4/persistent-store';
import writablePackagerOptionsStore from '../../src/p4/packager-options-store';
import {error} from '../../src/p4/stores';

beforeEach(() => {
  global.Blob = Blob;
  const values = new Map();
  global.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
  error.set(null);
});

test.each([
  ['P4.locale', 'en', 'zh-cn'],
  ['SelectProject.type', 'id', 'file'],
  ['SelectProject.id', '', '123456'],
  ['SelectProject.url', '', 'https://example.com/project.sb3']
])('restores %s without treating it as compiler options', (key, defaultValue, savedValue) => {
  localStorage.setItem(key, JSON.stringify(savedValue));
  expect(get(writablePersistentStore(key, defaultValue))).toBe(savedValue);
  expect(get(error)).toBeNull();
  expect(JSON.parse(localStorage.getItem(key))).toBe(savedValue);
});

test('language changes survive recreating the store', () => {
  const store = writablePersistentStore('P4.locale', 'en');
  const unsubscribe = store.subscribe(() => {});
  store.set('zh-cn');
  unsubscribe();
  expect(get(writablePersistentStore('P4.locale', 'en'))).toBe('zh-cn');
  expect(get(error)).toBeNull();
});

const defaultOptions = () => ({
  compiler: {enabled: true, warpTimer: false, seed: '', aggressiveRenaming: false},
  custom: {css: ''},
  cloudVariables: {mode: 'ws'},
  framerate: 30
});

test('legacy packager settings still report migration and preserve unrelated preferences', () => {
  const key = 'PackagerOptions.project';
  localStorage.setItem(key, JSON.stringify({
    compiler: {aot: true, protection: {online: true}},
    bakeExtensions: true,
    compiledProjectHooks: {},
    custom: {js: 'legacy()', css: 'body { color: red; }'},
    cloudVariables: {unsafeCloudBehaviors: true, mode: 'local'},
    framerate: 60
  }));
  const restored = get(writablePackagerOptionsStore(key, defaultOptions()));
  expect(get(error).message).toContain('原始 SB3');
  expect(restored).toEqual({
    compiler: defaultOptions().compiler,
    custom: {css: 'body { color: red; }'},
    cloudVariables: {mode: 'local'},
    framerate: 60
  });
  error.set(null);
  expect(get(writablePackagerOptionsStore(key, defaultOptions()))).toEqual(restored);
  expect(get(error)).toBeNull();
});

test('current packager settings retain seed, warp timing and aggressive renaming', () => {
  const key = 'PackagerOptions.project';
  const compiler = {enabled: true, seed: 'test-seed', warpTimer: true, aggressiveRenaming: true};
  localStorage.setItem(key, JSON.stringify({compiler}));
  expect(get(writablePackagerOptionsStore(key, defaultOptions())).compiler).toEqual(compiler);
  expect(get(error)).toBeNull();
});
