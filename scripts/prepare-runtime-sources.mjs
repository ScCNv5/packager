import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {rollup} from 'rollup';
import commonjs from '@rollup/plugin-commonjs';
import {nodeResolve} from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';
import {createHash} from 'node:crypto';
import {unbundleTWGL} from './unbundle-twgl.mjs';

const require = createRequire(import.meta.url);
const {parse} = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vm = path.resolve(root, '../scratch-vm');
const sourceRoot = path.join(root, 'src');
const vmSource = path.join(vm, 'src');
const nativeDependencies = ['scratch-render', 'scratch-audio', '@turbowarp/scratch-storage', '@turbowarp/scratch-svg-renderer']
  .map(name => path.join(root, 'node_modules', name, 'src') + path.sep);
const output = path.join(root, 'generated/runtime-sources.json');
const sources = {};
const provenance = {};
const ast = code => parse(code, {sourceType: 'unambiguous'});
const method = (name, body) => ast(`class A { ${name} ${body} }`).program.body[0].body.body[0];
const twglModules = unbundleTWGL(await fs.readFile(require.resolve('twgl.js'), 'utf8'));
const auditedWrappers = new Map();
for (const [file, hash] of [
  ['utils.js', 'c58704c6a6ef17f3e78a1ef4dd6e7aa20712fe673a929eb4c08fc86fcc9341cd'],
  ['base64.js', '5df6b73d9ed6c317c67835f3427d860c16fd93acf503eb471fd897167e747fdb']
]) {
  const filename = path.join(root, 'node_modules/@turbowarp/jszip/lib', file);
  if (createHash('sha256').update(await fs.readFile(filename)).digest('hex') !== hash) {
    throw new Error(`JSZip ${file} changed; review circular export initialization before updating the source pack`);
  }
  auditedWrappers.set(filename, {sha256: hash,
    reason: 'JSZip utils -> base64 -> utils captures partially initialized mutable CommonJS exports; preserve circular export identity and first-use ordering',
    cycle: ['@turbowarp/jszip/lib/utils.js', '@turbowarp/jszip/lib/base64.js', '@turbowarp/jszip/lib/utils.js']});
}

// Production source preparation happens once, in Node, before publishing the build tool.
// The browser receives resolved ESM, so it needs neither require() nor filesystem plugins.
function nativeModules(code, id) {
  const tree = ast(code);
  const imports = new Map();
  const getImport = name => {
    if (!imports.has(name)) imports.set(name, t.identifier(`__dependency${imports.size}`));
    return t.cloneNode(imports.get(name));
  };
  let exported = false;
  let namedExports = false;
  traverse(tree, {
    ReferencedIdentifier(p) {
      if (p.node.name === 'exports' && !p.scope.hasBinding('exports')) {
        namedExports = true; p.replaceWith(t.identifier('__exports'));
      }
    },
    CallExpression(p) {
      if (t.isIdentifier(p.node.callee, {name: 'require'})) {
        if (p.node.arguments.length !== 1 || !t.isStringLiteral(p.node.arguments[0])) {
          throw new Error(`Non-static first-party require in ${id}`);
        }
        p.replaceWith(getImport(p.node.arguments[0].value));
      }
    },
    ExpressionStatement(p) {
      const expression = p.node.expression;
      if (t.isAssignmentExpression(expression) && t.isMemberExpression(expression.left) &&
          t.isIdentifier(expression.left.object, {name: 'module'}) &&
          t.isIdentifier(expression.left.property, {name: 'exports'})) {
        if (exported) throw new Error(`Multiple CommonJS exports in ${id}`);
        exported = true;
        p.replaceWith(t.exportDefaultDeclaration(expression.right));
      }
    }
  });
  if (namedExports) {
    tree.program.body.unshift(...ast('const __exports = {};').program.body);
    tree.program.body.push(...ast('export default __exports;').program.body);
  }
  tree.program.body.unshift(...[...imports].map(([name, local]) =>
    t.importDeclaration([['@turbowarp/json', 'uuid', '@vernier/godirect', 'transformation-matrix'].includes(name) ?
      t.importNamespaceSpecifier(local) : t.importDefaultSpecifier(local)], t.stringLiteral(name))));
  return generate(tree, {comments: false}).code;
}

function prepareVM(code, id) {
  if (/\/engine\/blocks-(execute|runtime)-cache.js$/.test(id)) code = code.replace("require('./blocks');", '');
  const tree = ast(code);
  if (id.endsWith('/virtual-machine.js')) {
    // The playback facade and in-bundle addons are the only consumers of this class.
    const roots = new Set(['constructor', 'start', 'greenFlag', 'stopAll', 'quit', 'clear',
      'attachStorage', 'attachRenderer', 'attachAudioEngine', 'attachV2BitmapAdapter',
      'setVideoProvider', 'setCloudProvider', 'postIOData', 'setTurboMode', 'setCompatibilityMode',
      'setFramerate', 'setInterpolation', 'setRuntimeOptions', 'setCompilerOptions', 'setStageSize',
      'setInEditor', 'convertToPackagedRuntime', 'loadProject', 'getTargetIdForDrawableId',
      'startDrag', 'stopDrag', 'postSpriteInfo', 'setLocale', 'setTranslate', 'getLocale',
      'setVariableValue', 'getVariableValue', 'setListValue', 'getListValue', 'setEditingTarget',
      'scanForPeripheral', 'connectPeripheral', 'disconnectPeripheral', 'getPeripheralIsConnected',
      'securityManager', 'runtime', 'renderer', 'editingTarget']);
    const cls = tree.program.body.find(n => t.isClassDeclaration(n));
    traverse(tree, {ExpressionStatement(p) {
      const node = p.node.expression;
      if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left) &&
          t.isThisExpression(node.left.object) && ['exports', 'blockListener', 'flyoutBlockListener',
            'monitorBlockListener', 'variableListener'].includes(node.left.property.name)) p.remove();
    }});
    const load = cls.body.body.find(n => n.key.name === 'loadProject');
    load.async = true;
    load.body = ast(`async function load(input) {
      const project = typeof input === 'string' ? JSON.parse(input) :
        input instanceof ArrayBuffer || ArrayBuffer.isView(input) ? JSON.parse(new TextDecoder().decode(input)) : input;
      this.clear();
      for (const id of project.extensions || []) await this.extensionManager.loadExtensionURL((project.extensionURLs || {})[id] || id);
      const {targets} = await require('./serialization/sb3').deserialize(project, this.runtime);
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        target.sprite.__spTarget = index;
        this.runtime.addTarget(target);
        target.updateAllDrawableProperties();
      }
      this.runtime.executableTargets.sort((a,b) => a.layerOrder-b.layerOrder);
      targets.forEach(target => { delete target.layerOrder; });
      this.editingTarget = targets[1] || targets[0];
      this.runtime.setEditingTarget(this.editingTarget);
      this.runtime.ioDevices.cloud.setStage(this.runtime.getTargetForStage());
      this.runtime.handleProjectLoaded();
    }`).program.body[0].body;
    let changed = true;
    while (changed) {
      changed = false;
      for (const member of cls.body.body) if (roots.has(member.key.name)) {
        t.traverseFast(member, node => {
          if (t.isMemberExpression(node) && t.isThisExpression(node.object) &&
              !node.computed && !roots.has(node.property.name)) {
            roots.add(node.property.name); changed = true;
          }
        });
      }
    }
    cls.body.body = cls.body.body.filter(member => roots.has(member.key.name));
  }
  if (id.endsWith('/engine/sequencer.js')) {
    tree.program.body.unshift(...ast("const SpecializedBlockUtility = require('../compiler/specialized-block-utility'); const Cast = require('../util/cast'); const log = require('../util/log');").program.body);
    const cls = tree.program.body.find(n => t.isClassDeclaration(n));
    cls.body.body = cls.body.body.filter(n => !['stepThread', 'stepToBranch', 'stepToProcedure'].includes(n.key.name));
    cls.body.body.push(method('stepThread(thread)', `{ '__SPECIALIZED_STEP__'; }`));
    const retire = cls.body.body.find(n => n.key.name === 'retireThread');
    retire.body.body.unshift(...ast('thread.__spLifetime = null; thread.__spFrames = [];').program.body);
  }
  if (id.endsWith('/engine/runtime.js')) {
    const cls = tree.program.body.find(n => t.isClassDeclaration(n));
    cls.body.body = cls.body.body.filter(n => !['startHats', 'getOpcodeFunctionById'].includes(n.key.name));
    cls.body.body.push(method('startHats(opcode, fields, target)', `{ '__SPECIALIZED_HATS__'; }`));
    cls.body.body.push(method('__spPrimitive(opcode, args, utility)', `{ '__SPECIALIZED_PRIMITIVE__'; }`));
    for (const name of ['_pushThread', '_restartThread']) {
      const m = cls.body.body.find(n => n.key.name === name);
      // All threads use the linked sequencer. A new Thread has a new lifetime identity.
      t.traverseFast(m, node => {
        if (t.isCallExpression(node) && t.isMemberExpression(node.callee) &&
            t.isIdentifier(node.callee.property, {name: 'tryCompile'})) {
          node.callee.property.name = '__spInitialize';
        }
      });
      if (name === '_restartThread') {
        m.body.body.unshift(...ast('thread.__spLifetime = null;').program.body);
        t.traverseFast(m, node => {
          if (t.isReturnStatement(node) && t.isIdentifier(node.argument, {name: 'newThread'})) {
            node.argument = t.sequenceExpression([
              t.assignmentExpression('=', t.memberExpression(t.identifier('newThread'), t.identifier('executableHat')),
                t.memberExpression(t.identifier('thread'), t.identifier('executableHat'))), node.argument]);
          }
        });
      }
    }
  }
  if (id.endsWith('/engine/thread.js')) {
    const cls = tree.program.body.find(n => t.isClassDeclaration(n, {id: {name: 'Thread'}})) ||
      tree.program.body.filter(n => t.isClassDeclaration(n)).at(-1);
    cls.body.body = cls.body.body.filter(n => !['tryCompile', 'getCompiledProcedure', 'stopThisScript'].includes(n.key.name));
    cls.body.body.push(method('__spInitialize()', `{
      this.triedToCompile = true; this.isCompiled = true;
      this.__spLifetime = {};
      this.__spFrames = [{__spPC: Number(this.topBlock), __spSlots: [], __spArgs: [], __spReturn: -1}];
    }`));
  }
  // Remove now-unused top-level require bindings before module resolution.
  traverse(tree, {Program(p) {
    p.scope.crawl();
    for (const binding of Object.values(p.scope.bindings)) {
      if (binding.referenced || ['SpecializedBlockUtility', 'Cast', 'log', 'execute'].includes(binding.identifier.name) || !binding.path.isVariableDeclarator()) continue;
      if (binding.path.node.init && t.isCallExpression(binding.path.node.init) &&
          t.isIdentifier(binding.path.node.init.callee, {name: 'require'})) binding.path.remove();
    }
  }});
  return generate(tree, {comments: false}).code;
}

const stub = `const unavailable = () => { throw new Error('This player contains no dynamic compiler'); };
unavailable.saveGlobalState = () => {}; unavailable.restoreGlobalState = () => {};
export default unavailable;`;
const aliases = {
  'scratch-vm': path.join(vmSource, 'index.js'),
  'scratch-render': path.join(root, 'node_modules/scratch-render/src/index.js'),
  'scratch-audio': path.join(root, 'node_modules/scratch-audio/src/index.js'),
  '@turbowarp/scratch-storage': path.join(root, 'node_modules/@turbowarp/scratch-storage/src/index.js'),
  '@turbowarp/jszip': path.join(root, 'node_modules/@turbowarp/jszip/lib/index.js'),
  '@turbowarp/scratch-svg-renderer': path.join(root, 'node_modules/@turbowarp/scratch-svg-renderer/src/index.js'),
  'transformation-matrix': path.join(root, 'node_modules/transformation-matrix/src/index.js'),
  '@vernier/godirect': path.join(vm, 'node_modules/@vernier/godirect/src/godirect.js'),
  'scratch-parser': path.join(sourceRoot, 'scaffolding/scratch-parser/index.js'),
  'text-encoding': path.join(sourceRoot, 'scaffolding/text-encoding/index.js'),
  'htmlparser2': path.join(sourceRoot, 'scaffolding/htmlparser2/index.js'),
  'scratch-translate-extension-languages': path.join(sourceRoot, 'scaffolding/scratch-translate-extension-languages/languages.json'),
  events: require.resolve('events/'),
  buffer: require.resolve('buffer/'),
  util: require.resolve('util/'),
  stream: require.resolve('stream-browserify'),
  crypto: require.resolve('crypto-browserify'),
  assert: require.resolve('assert/'),
  process: require.resolve('process/browser')
};

const bundle = await rollup({
  input: ['\0specialized-entry', '\0specialized-extension-api'],
  treeshake: false,
  onwarn(warning) {
    if (['CIRCULAR_DEPENDENCY', 'THIS_IS_UNDEFINED'].includes(warning.code)) return;
    console.warn(warning.message);
  },
  plugins: [{
    name: 'prepared-runtime',
    resolveId(source, importer) {
      if (source.startsWith('\0specialized')) return source;
      if (source === 'twgl.js') return '\0specialized-twgl:9.js';
      if (source === 'setimmediate') return '\0specialized-immediate';
      if (aliases[source]) return aliases[source];
      if (source.startsWith('!ify-loader!')) return require.resolve(source.slice('!ify-loader!'.length));
      if (/^!?(worker-loader|raw-loader|arraybuffer-loader|base64-loader)[!?]/.test(source)) {
        return `\0asset:${path.resolve(path.dirname(importer), source.slice(source.lastIndexOf('!') + 1))}:${source.includes('raw-loader') ? 'raw' : source.includes('arraybuffer-loader') ? 'bytes' : source.includes('base64-loader') ? 'base64' : 'worker'}`;
      }
      if (source === 'fs' || source === 'path' || source === 'http' || source === 'https') return '\0specialized-empty';
    },
    async load(id) {
      if (id.startsWith('\0specialized-twgl:')) return nativeModules(twglModules[parseInt(id.split(':')[1], 10)], id);
      // Production players run in a browser, including desktop WebViews. ZIP
      // resources never expose Node streams and the supported engines have Promise.
      if (id.endsWith('/@turbowarp/jszip/lib/external.js')) return 'module.exports = {Promise};';
      if (id === '\0specialized-extension-api') return `
        import Cast from ${JSON.stringify(path.join(vmSource, 'util/cast.js'))};
        ${['ArgumentType:argument-type', 'BlockType:block-type', 'BlockShape:tw-block-shape', 'TargetType:target-type'].map(item => {
          const [name, file] = item.split(':');
          return `import ${name} from ${JSON.stringify(path.join(vmSource, `extension-support/${file}.js`))};`;
        }).join('\n')}
        export default {Cast, ArgumentType, BlockType, BlockShape, TargetType};`;
      if (id.endsWith('/scaffolding/scratch-libraries.js')) return `
        export {default as VM} from 'scratch-vm';
        export {default as Renderer} from 'scratch-render';
        export {default as ScratchStorage} from '@turbowarp/scratch-storage';
        export {default as AudioEngine} from 'scratch-audio';
        export {default as BitmapAdapter} from ${JSON.stringify(path.join(root, 'node_modules/@turbowarp/scratch-svg-renderer/src/bitmap-adapter.js'))};`;
      if (id === '\0specialized-empty') return 'export default {};';
      if (id === '\0specialized-immediate') return `if (!globalThis.setImmediate) {
        globalThis.setImmediate = (callback, ...args) => {
          if (typeof callback !== 'function') throw new TypeError('setImmediate requires a function');
          return setTimeout(callback, 0, ...args);
        }; globalThis.clearImmediate = clearTimeout;
      } export default {};`;
      if (id.endsWith('/extension-support/tw-iframe-extension-worker.js')) return `export default class Unavailable { constructor() { throw new Error('Only worker extensions are supported'); } }`;
      if (id.endsWith('/extension-support/tw-unsandboxed-extension-runner.js')) return `export default {load() { throw new Error('Unsandboxed extensions are not supported'); }};`;
      if (id.endsWith('/addons/unsafe-cloud-behaviors.js')) return `export default function () { throw new Error('Dynamic cloud code is not supported'); }`;
      if (id === path.join(vmSource, 'index.js')) return `export {default} from './virtual-machine.js';`;
      if (id === '\0specialized-entry') return `import * as Scaffolding from ${JSON.stringify(path.join(sourceRoot, 'scaffolding/scaffolding.js'))};
        import * as ScaffoldingAddons from ${JSON.stringify(path.join(sourceRoot, 'addons/index.js'))};
        export {Scaffolding, ScaffoldingAddons};`;
      if (/\/compiler\/(compile|jsexecute|specialized-project)(\.js)?$/.test(id)) return stub;
      if (id.endsWith('/engine/execute.js')) return `export default function execute(sequencer, thread) {
        if (!thread.updateMonitor) throw new Error('No interpreter in specialized player');
        const runtime = sequencer.runtime;
        const block = runtime.monitorBlocks.getBlock(thread.topBlock);
        if (!block) { sequencer.retireThread(thread); return; }
        const args = {};
        for (const [key, field] of Object.entries(block.fields || {})) args[key] = key === 'VARIABLE' || key === 'LIST' ? field : field.value;
        const utility = {target: thread.target, runtime, thread,
          ioQuery: (device, operation, args = []) => runtime.ioDevices[device][operation](...args)};
        const value = runtime.__spPrimitive(block.opcode, args, utility);
        if (value !== undefined) runtime.requestUpdateMonitor({id: thread.topBlock, value,
          spriteName: block.targetId ? thread.target.getName() : null});
        sequencer.retireThread(thread);
      }`;
      if (id.startsWith('\0asset:')) {
        const [, filename, kind] = id.split(':');
        if (kind === 'worker') return `export default class WorkerUnavailable { constructor() { throw new Error('Extension worker source was not linked'); } }`;
        const bytes = await fs.readFile(filename);
        if (kind === 'raw') return `export default ${JSON.stringify(bytes.toString())};`;
        if (kind === 'base64') return `export default ${JSON.stringify(bytes.toString('base64'))};`;
        return `export default Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0)).buffer;`;
      }
      if (/\.(svg|png|jpg|mp3|wav)$/.test(id)) {
        const bytes = await fs.readFile(id);
        if (id.includes('/scratch-storage/') || id.includes('/@turbowarp/scratch-storage/')) {
          return `export default Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0));`;
        }
        const ext = path.extname(id).slice(1);
        const type = {svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', mp3: 'audio/mpeg', wav: 'audio/wav'}[ext];
        return `export default ${JSON.stringify(`data:${type};base64,${bytes.toString('base64')}`)};`;
      }
      if (id.endsWith('.css')) {
        const css = await fs.readFile(id, 'utf8');
        const classes = {};
        const transformed = css.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => {
          classes[name.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = `sc-${name}`;
          return `.sc-${name}`;
        });
        return `const style = document.createElement('style'); style.textContent = ${JSON.stringify(transformed)};
          document.head.appendChild(style); export default ${JSON.stringify(classes)};`;
      }
    },
    async transform(code, id) {
      if (id.endsWith('/@turbowarp/jszip/lib/support.js')) {
        const tree = ast(code);
        tree.program.body = tree.program.body.filter(node => !t.isTryStatement(node));
        tree.program.body.push(...ast('exports.nodestream = false;').program.body);
        code = generate(tree, {comments: false}).code;
      }
      if (id.endsWith('/@turbowarp/jszip/lib/stream/StreamHelper.js')) {
        const tree = ast(code);
        tree.program.body = tree.program.body.filter(node => !(t.isIfStatement(node) &&
          t.isMemberExpression(node.test) && t.isIdentifier(node.test.object, {name: 'support'}) &&
          t.isIdentifier(node.test.property, {name: 'nodestream'})));
        code = generate(tree, {comments: false}).code;
      }
      if (/\.[cm]?js$/.test(id)) {
        const globals = new Set();
        const tree = ast(code);
        traverse(tree, {ReferencedIdentifier(p) {
          if (['global', 'process', 'Buffer'].includes(p.node.name) && !p.scope.hasBinding(p.node.name)) globals.add(p.node.name);
        }});
        code = [...globals].map(name => name === 'global' ? 'const global = globalThis;' :
          name === 'Buffer' ? "const Buffer = require('buffer').Buffer;" : "const process = require('process');").join('\n') + '\n' + code;
      }
      if (/node_modules\/js-md5\/src\/md5.js$/.test(id)) {
        code = code.replace(/var NODE_JS = [^;]+;/, 'var NODE_JS = false;');
        return {code, map: null};
      }
      const textUtility = /node_modules\/(grapheme-breaker|linebreak)\/(?!node_modules\/).*\.js$/.test(id);
      if (textUtility) {
        const matches = [...code.matchAll(/fs\.readFileSync\(__dirname \+ '([^']+)'(?:, '([^']+)')?\)/g)];
        for (const match of matches) {
          const bytes = await fs.readFile(path.join(path.dirname(id), match[1]));
          code = code.replace(match[0], match[2] === 'base64' ? JSON.stringify(bytes.toString('base64')) :
            `require('buffer').Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64')`);
        }
        // CoffeeScript's outer one-shot closure is only a module scope. Unwrap
        // it before converting its exports; nested implementation closures stay.
        const tree = ast(code);
        const statement = tree.program.body.at(-1);
        const call = statement?.expression;
        if (t.isCallExpression(call) && t.isMemberExpression(call.callee) &&
            t.isFunctionExpression(call.callee.object) && t.isIdentifier(call.callee.property, {name: 'call'}) &&
            call.arguments.length === 1 && t.isThisExpression(call.arguments[0])) {
          tree.program.body.splice(-1, 1, ...call.callee.object.body.body);
        }
        code = generate(tree, {comments: false}).code;
      }
      const acyclicUtility = textUtility || /\/node_modules\/(pako|tiny-inflate|base64-js|unicode-trie)\//.test(id);
      if (!id.startsWith(vmSource) && !id.startsWith(sourceRoot) && !acyclicUtility && !nativeDependencies.some(prefix => id.startsWith(prefix))) return {code, map: null};
      if (!/\.[cm]?js$/.test(id)) return;
      if (id.endsWith('/addons/index.js')) code = code.replace('window.ScaffoldingAddons = {\n  run\n};', 'export {run};');
      if (id.startsWith(vmSource)) code = prepareVM(code, id);
      code = code.replace(/process\.env\.NODE_ENV/g, '"production"');
      const result = nativeModules(code, id);
      return {code: result, map: null};
    }
  }, nodeResolve({browser: true, preferBuiltins: false, mainFields: ['browser', 'module', 'main']}),
  json(), commonjs({strictRequires: [...auditedWrappers.keys()], transformMixedEsModules: true, requireReturnsDefault: 'auto'})]
});
const generated = await bundle.generate({format: 'es', preserveModules: true, entryFileNames: '[name].js',
  chunkFileNames: '[name]-[hash].js', generatedCode: 'es2015'});
let entry, extensionApi;
const wrapperAudit = {};
for (const item of generated.output) {
  if (item.type !== 'chunk') throw new Error(`Unexpected source-pack asset ${item.fileName}`);
  sources[item.fileName] = item.code;
  provenance[item.fileName] = Object.keys(item.modules).map(id => id.startsWith('\0specialized-twgl:') ?
    `tw-packager/node_modules/twgl.js/dist/4.x/twgl-full.js#module-${parseInt(id.split(':')[1], 10)}` :
    id.replace(vm, 'scratch-vm').replace(root, 'tw-packager'));
  if (item.exports.includes('__require')) {
    const audits = Object.keys(item.modules).map(id => auditedWrappers.get(id)).filter(Boolean);
    if (audits.length !== 1) throw new Error(`Unaudited CommonJS wrapper: ${item.fileName}`);
    wrapperAudit[item.fileName] = audits[0];
  }
  if (item.facadeModuleId === '\0specialized-entry') entry = item.fileName;
  if (item.facadeModuleId === '\0specialized-extension-api') extensionApi = item.fileName;
}
// Share the existing scalar semantics, while excluding generator/execution helpers.
const helperTree = ast(await fs.readFile(path.join(vmSource, 'compiler/jsexecute.js'), 'utf8'));
const helperParts = [];
const excluded = new Set(['startHats', 'waitThreads', 'executeInCompatibilityLayer', 'retire',
  'timer', 'distance', 'yieldThenCall', 'yieldThenCallGenerator', 'createBranchInfo']);
traverse(helperTree, {AssignmentExpression(p) {
  const {left, right} = p.node;
  if (!t.isTemplateLiteral(right) || right.expressions.length) return;
  if (t.isIdentifier(left, {name: 'baseRuntime'}) ||
      (t.isMemberExpression(left) && t.isIdentifier(left.object, {name: 'runtimeFunctions'}) && !excluded.has(left.property.name))) {
    helperParts.push(right.quasis[0].value.cooked);
  }
}});
const helperAST = ast(helperParts.join('\n'));
helperAST.program.body = helperAST.program.body.filter(n => !t.isVariableDeclaration(n) ||
  !n.declarations.some(d => ['stuckCounter', 'isStuck', 'colorToList'].includes(d.id.name)));
helperAST.program.body = helperAST.program.body.map(n => t.isVariableDeclaration(n) ? t.exportNamedDeclaration(n) : n);
const helpers = generate(helperAST, {comments: false}).code;
const fingerprint = createHash('sha256').update(JSON.stringify({sources, helpers})).digest('hex');
await fs.mkdir(path.dirname(output), {recursive: true});
await fs.writeFile(output, JSON.stringify({version: 1, fingerprint, entry, extensionApi, sources, provenance, helpers, wrapperAudit}));
await bundle.close();
console.log(`Prepared ${Object.keys(sources).length} runtime modules (${fingerprint.slice(0, 12)})`);
