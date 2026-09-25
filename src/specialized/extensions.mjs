import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import {auditArtifact} from './link.mjs';
const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;

// All code dependencies must be provided to this memory linker. URL fetching is
// a build-host responsibility; the resulting worker cannot load more scripts.
export async function prepareExtension({url, sources}, sourcePack, rollup) {
  const missing = name => {
    const error = new Error(`Missing frozen extension dependency: ${name}`);
    error.missingDependency = name;
    throw error;
  };
  const visiting = new Set();
  const included = new Set();
  const flatten = name => {
    if (!Object.hasOwn(sources, name)) missing(name);
    if (visiting.has(name)) throw new Error(`Cyclic importScripts dependency: ${name}`);
    visiting.add(name); included.add(name);
    const tree = parse(sources[name], {sourceType: 'module'});
    traverse(tree, {
      VariableDeclarator(p) {
        if (t.isIdentifier(p.node.init, {name: 'Scratch'}) && t.isObjectPattern(p.node.id) && p.node.id.properties.some(property =>
          t.isObjectProperty(property) && ['vm', 'runtime', 'compiler'].includes(property.key.name || property.key.value))) {
          throw new Error('Fixed extensions cannot access the VM or modify the compiler');
        }
      },
      ReferencedIdentifier(p) {
        if (p.node.name === 'vm' && !p.scope.hasBinding('vm')) throw new Error('Fixed extensions cannot access a global VM');
      },
      MemberExpression(p) {
        const node = p.node;
        const key = node.computed ? t.isStringLiteral(node.property) && node.property.value : node.property.name;
        if (t.isIdentifier(node.object, {name: 'Scratch'}) &&
          (!key || ['vm', 'runtime', 'compiler'].includes(key))) throw new Error('Fixed extensions cannot access the VM or modify the compiler');
        if (t.isMemberExpression(node.object) && t.isIdentifier(node.object.object, {name: 'Scratch'}) &&
          node.object.property.name === 'extensions' && key && !['register', 'unsandboxed'].includes(key)) {
          throw new Error('Extensions cannot load or register new extension code at runtime');
        }
      },
      CallExpression(p) {
        if (!t.isIdentifier(p.node.callee, {name: 'importScripts'})) return;
        if (!p.parentPath.isExpressionStatement() || !p.node.arguments.every(t.isStringLiteral)) {
          throw new Error('Extension code dependencies must use literal importScripts URLs');
        }
        const statements = p.node.arguments.flatMap(arg => flatten(new URL(arg.value, name).href));
        p.parentPath.replaceWithMultiple(statements); p.skip();
      },
      ImportDeclaration(p) {
        p.node.source.value = new URL(p.node.source.value.value, name).href;
      },
      'ExportNamedDeclaration|ExportAllDeclaration'(p) {
        if (p.node.source) p.node.source.value = new URL(p.node.source.value, name).href;
      }
    });
    visiting.delete(name);
    return tree.program.body;
  };
  const body = generate(t.file(t.program(flatten(url))), {comments: false}).code;
  const bootstrap = `import common from ${JSON.stringify(sourcePack.extensionApi)};
    const objects = [];
    const deny = () => { throw new Error('This operation is unavailable in a fixed sandboxed extension'); };
    const Scratch = Object.freeze({...common, external: deny,
      extensions: Object.freeze({unsandboxed: false, register: object => objects.push(object)}),
      translate: message => typeof message === 'string' ? message : message.default,
      canFetch: () => Promise.resolve(true), fetch: (...args) => fetch(...args),
      canOpenWindow: () => Promise.resolve(false), openWindow: deny,
      canRedirect: () => Promise.resolve(false), redirect: deny,
      canRecordAudio: () => Promise.resolve(false), canRecordVideo: () => Promise.resolve(false)});
    self.Scratch = Scratch;
    ${body}
    const infos = objects.map(object => object.getInfo());
    self.postMessage({type: 'ready', infos});
    self.onmessage = async ({data}) => {
      if (data.type !== 'call') return;
      try {
        const object = objects[data.extension];
        const info = infos[data.extension];
        const block = info.blocks.find(block => block && typeof block === 'object' && (block.func || block.opcode) === data.method);
        if (!block) throw new Error('Unregistered extension operation');
        let value = await object[data.method](data.args);
        if (!['number', 'string', 'boolean'].includes(typeof value)) value = String(value);
        self.postMessage({type: 'result', id: data.id, value});
      } catch (error) { self.postMessage({type: 'result', id: data.id, error: String(error)}); }
    };`;
  const modules = {...sourcePack.sources, ...sources, 'fixed-extension.js': bootstrap};
  const bundle = await rollup({input: 'fixed-extension.js', plugins: [{
    name: 'frozen-extension', resolveId(source, importer) {
      let id = source;
      if (source.startsWith('.')) {
        if (/^https?:/.test(importer)) id = new URL(source, importer).href;
        else {
        const parts = (importer || '').split('/'); parts.pop();
        for (const part of source.split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); }
        id = parts.join('/');
        }
      }
      if (!Object.hasOwn(modules, id)) missing(id);
      return id;
    }, load(id) {
      if (Object.hasOwn(sources, id)) return generate(t.file(t.program(flatten(id))), {comments: false}).code;
      return modules[id];
    }
  }], onwarn(warning) { if (warning.code !== 'CIRCULAR_DEPENDENCY') throw new Error(warning.message); }});
  try {
    const {output} = await bundle.generate({format: 'iife', inlineDynamicImports: true});
    const code = output[0].code;
    auditArtifact(code, {allowGenerators: true});
    return {code, dependencies: [...included].sort()};
  } finally { await bundle.close(); }
}
