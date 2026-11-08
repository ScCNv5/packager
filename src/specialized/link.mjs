import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';
import {minify} from 'terser';
import {extensionLoaderBody} from './extension-runtime.mjs';
import {collectVMProperties, rewriteThreadStatus, threadStatusProperty, publicProperties} from './aggressive-properties.mjs';

const traverse = traverseModule.default || traverseModule;
const generate = generateModule.default || generateModule;
const parseCode = code => parse(code, {sourceType: 'module'});
const print = tree => generate(tree, {comments: false}).code;
const parseMethod = source => parseCode(`class A { ${source} }`).program.body[0].body.body[0];
const keyName = node => node.computed ? t.isStringLiteral(node.key) && node.key.value : node.key.name || node.key.value;
const q = JSON.stringify;

function cachePureComputation(tree, blocks) {
  const provenReferences = new Map(blocks.map(block => [block.id, new Set(block.cacheableReferences || [])]));
  const helpers = new Set(['toNotNaN', 'toBoolean', 'compareEqual', 'compareLessThan', 'compareGreaterThan',
    'mod', 'randomInt', 'randomFloat', 'random', 'listGet', 'listReplace', 'listInsert', 'listDelete',
    'listContains', 'listIndexOf', 'listContents', 'letterOf', 'stringContains', 'tan']);
  let count = 0;
  traverse(tree, {LabeledStatement: {exit(region) {
    if (region.node.label.name !== '__spCompute') return;
    const casePath = region.findParent(p => p.isSwitchCase());
    const proven = casePath && provenReferences.get(casePath.node.test?.value);
    if (!proven) return;
    const candidates = new Map();
    const exits = [];
    let pure = true;
    region.traverse({
      LabeledStatement(p) {
        if (p.node.label.name === '__spLeave') { exits.push(p); p.skip(); }
      },
      Function() { pure = false; },
      CallExpression(p) {
        const callee = p.node.callee;
        if (t.isIdentifier(callee) && helpers.has(callee.name)) {
          const binding = p.scope.getBinding(callee.name);
          if (binding?.path.isImportSpecifier() && binding.path.parent.source.value === 'specialized-helpers.js') return;
        }
        if (t.isMemberExpression(callee) && !callee.computed &&
            t.isIdentifier(callee.object, {name: 'Math'}) && !p.scope.getBinding('Math')) return;
        // Native array operations on owned Scratch list values have no VM callbacks.
        if (t.isMemberExpression(callee) && !callee.computed && ['push', 'pop', 'splice'].includes(callee.property.name) &&
            t.isMemberExpression(callee.object) && !callee.object.computed &&
            callee.object.property.name === 'value' && t.isIdentifier(callee.object.object) &&
            callee.object.object.name.startsWith('__spV')) return;
        pure = false;
      },
      MemberExpression(p) {
        const node = p.node;
        if (!t.isIdentifier(node.object) || !proven.has(node.object.name) || node.computed || node.property.name !== 'value') return;
        const binding = p.scope.getBinding(node.object.name);
        if (!binding?.path.isVariableDeclarator() || !t.isLogicalExpression(binding.path.node.init)) return;
        const assignment = binding.path.node.init.right;
        if (!t.isAssignmentExpression(assignment) || !t.isMemberExpression(assignment.right) ||
            !t.isStringLiteral(assignment.right.property) || !t.isMemberExpression(assignment.right.object) ||
            assignment.right.object.computed || assignment.right.object.property.name !== 'variables' ||
            !t.isIdentifier(assignment.right.object.object) ||
            !['target', 'stage'].includes(assignment.right.object.object.name)) return;
        if (!candidates.has(binding)) candidates.set(binding, []);
        candidates.get(binding).push(p);
      }
    });
    if (!pure) return;
    const declarations = [], commits = [];
    const ids = new Map();
    const aliases = new Set([...candidates.keys()].flatMap(binding => Object.values(binding.scope.bindings)));
    for (const binding of aliases) {
      const init = binding.path.node.init;
      if (!t.isLogicalExpression(init) || !t.isAssignmentExpression(init.right) ||
          !t.isMemberExpression(init.right.right) || !t.isStringLiteral(init.right.right.property)) continue;
      const id = init.right.right.property.value;
      ids.set(id, (ids.get(id) || 0) + 1);
    }
    for (const [binding, accesses] of candidates) {
      // Stage scripts can reference the same object through target and stage.
      if (ids.get(binding.path.node.init.right.right.property.value) > 1) continue;
      // A helper receiving the variable object might observe or change .value.
      // Keep those objects live; cache only scalars/array references used directly.
      const scopedReferences = binding.referencePaths.filter(p => p.findParent(parent => parent === region));
      if (scopedReferences.some(p => !p.parentPath.isMemberExpression() || p.parentPath.node.object !== p.node ||
          p.parentPath.node.computed || p.parentPath.node.property.name !== 'value')) continue;
      if (accesses.some(p => p.parentPath.isCallExpression() && p.parentPath.node.callee === p.node)) continue;
      const temporary = region.scope.generateUidIdentifier('scalar');
      declarations.push(t.variableDeclarator(t.cloneNode(temporary), t.memberExpression(t.identifier(binding.identifier.name), t.identifier('value'))));
      let written = false;
      for (const access of accesses) {
        if (access.parentPath.isAssignmentExpression() && access.parentPath.node.left === access.node || access.parentPath.isUpdateExpression()) written = true;
        access.replaceWith(t.cloneNode(temporary));
      }
      if (written) commits.push(t.expressionStatement(t.assignmentExpression('=',
        t.memberExpression(t.identifier(binding.identifier.name), t.identifier('value')), t.cloneNode(temporary))));
      count++;
    }
    if (declarations.length) {
      // Commit before the fused VM return/retirement path can emit an event or
      // enter another continuation. The finally also commits on an exception.
      for (const exit of exits) exit.node.body.body.unshift(...commits.map(node => t.cloneNode(node, true)));
      const body = region.node.body;
      region.node.body = t.blockStatement([t.variableDeclaration('let', declarations),
        ...(commits.length ? [t.tryStatement(body, null, t.blockStatement(commits))] : body.body)]);
    }
  }}});
  return count;
}

function removeUnusedImports(tree) {
  traverse(tree, {Program(p) {
    p.scope.crawl();
    for (const binding of Object.values(p.scope.bindings)) {
      if (!binding.referenced && binding.path.isVariableDeclarator() && t.isIdentifier(binding.path.node.init)) binding.path.remove();
    }
    p.scope.crawl();
    for (const statement of p.get('body')) {
      if (!statement.isImportDeclaration() || statement.node.specifiers.length === 0) continue;
      statement.node.specifiers = statement.node.specifiers.filter(specifier => p.scope.getBinding(specifier.local.name)?.referenced);
      if (statement.node.specifiers.length === 0) statement.remove();
    }
  }});
}

export const seedNumber = seed => {
  let hash = 2166136261;
  for (const char of String(seed)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};

export function dispatchGroups(blocks) {
  if (blocks.length && blocks.every(block => Number.isInteger(block.dispatchGroup))) {
    const grouped = new Map();
    for (const block of [...blocks].sort((a, b) => a.id - b.id)) {
      if (!grouped.has(block.dispatchGroup)) grouped.set(block.dispatchGroup, []);
      grouped.get(block.dispatchGroup).push(block);
    }
    return [...grouped.values()];
  }
  const groups = [];
  let group = [], length = 0;
  for (const block of [...blocks].sort((a, b) => a.id - b.id)) {
    const size = block.code.join('\n').length;
    // Limit actual functions, not just switches in one enormous function. Keep
    // native hot loops intact even when a single region exceeds this budget.
    if (group.length && (group.length >= 256 || length + size > 12000)) {
      groups.push(group); group = []; length = 0;
    }
    group.push(block); length += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export function stepMethods(blocks) {
  const groups = dispatchGroups(blocks);
  if (groups.length <= 1) return {stepThread: stepBody(blocks)};
  const methods = {};
  const encoded = groups.every((group, index) => group.every(block => (block.id >>> 8) === index + 1));
  const dispatch = (from, to) => {
    if (encoded && to - from <= 256) return `switch (pc >>> 8) {
      ${groups.slice(from, to).map((_, offset) => `case ${from + offset + 1}:
        if (!this.__spDispatch${from + offset}(thread)) return; break;`).join('\n')}
      default: throw new Error('Invalid continuation');
    }`;
    if (to - from === 1) return `if (!this.__spDispatch${from}(thread)) return;`;
    const middle = (from + to) >>> 1;
    return `if (pc <= ${groups[middle - 1].at(-1).id}) { ${dispatch(from, middle)} }
      else { ${dispatch(middle, to)} }`;
  };
  methods.stepThread = `{
    if (thread.updateMonitor) { execute(this, thread); return; }
    __spRun: while (!thread.isKilled && thread.status !== 4 && thread.__spFrames.length) {
      const pc = thread.__spFrames[thread.__spFrames.length - 1].__spPC;
      if (pc < ${groups[0][0].id} || pc > ${groups.at(-1).at(-1).id}) throw new Error('Invalid continuation');
      ${dispatch(0, groups.length)}
    }
  }`;
  groups.forEach((group, index) => { methods[`__spDispatch${index}`] = stepBody(group, true); });
  return methods;
}

export function stepBody(blocks, transfer = false) {
  const ordered = [...blocks].sort((a, b) => a.id - b.id);
  const dispatch = regions => {
    if (regions.length <= 256) return `switch (frame.__spPC) {
      ${regions.map(block => `case ${block.id}: { ${block.code.join('\n')} }`).join('\n')}
      default:
        ${transfer ? `if (frame.__spPC < ${ordered[0].id} || frame.__spPC > ${ordered.at(-1).id}) return true;` : ''}
        throw new Error('Invalid continuation');
    }`;
    const middle = Math.ceil(regions.length / 512) * 256;
    return `if (frame.__spPC <= ${regions[middle - 1].id}) {
      ${dispatch(regions.slice(0, middle))}
    } else { ${dispatch(regions.slice(middle))} }`;
  };
  return `{
    if (thread.updateMonitor) { execute(this, thread); return; }
    const target = thread.target, runtime = this.runtime;
    const variables = thread.__spVariables || (thread.__spVariables = []);
    ${blocks.some(block => block.code.some(code => /\bstage\b/.test(code))) ? 'const stage = runtime.getTargetForStage();' : ''}
    const isStuck = () => {
      thread.__spStuck = (thread.__spStuck || 0) + 1;
      if (thread.__spStuck < 100) return false;
      thread.__spStuck = 0; return this.timer.timeElapsed() > 500;
    };
    const timer = () => { const value = new Timer({now: () => runtime.currentMSecs}); value.start(); return value; };
    const colorToList = color => Cast.toRgbColorList(color);
    const distance = menu => {
      if (target.isStage) return 10000;
      const other = menu === '_mouse_' ? {x: runtime.ioDevices.mouse.getScratchX(), y: runtime.ioDevices.mouse.getScratchY()} : runtime.getSpriteTargetByName(menu);
      return other ? Math.hypot(target.x - other.x, target.y - other.y) : 10000;
    };
    __spRun: while (!thread.isKilled && thread.status !== 4 && thread.__spFrames.length) {
      const frame = thread.__spFrames[thread.__spFrames.length - 1];
      ${dispatch(ordered)}
    }
  }`;
}

export function hatsBody(hats) {
  return `{
    const specs = ${q(hats)};
    const originalLength = this.threads.length;
    const started = [];
    // executableTargets order, including clones, is part of Scratch broadcast semantics.
    const candidates = target ? [target] : this.executableTargets;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      for (const spec of specs) {
        if (spec.opcode !== opcode || spec.target !== candidate.sprite.__spTarget) continue;
        if (fields && Object.keys(fields).some(key => spec.fields[key] !==
          (typeof fields[key] === 'string' ? fields[key].toUpperCase() : fields[key]))) continue;
        const id = String(spec.pc);
        if (spec.metadata.restartExistingThreads) {
          const existing = this.threadMap.get(Thread.getIdFromTargetAndBlock(candidate, id));
          if (existing) { started.push(this._restartThread(existing)); continue; }
        } else if (this.threads.slice(0, originalLength).some(thread =>
          thread.target === candidate && thread.topBlock === id && !thread.stackClick && thread.status !== 4)) continue;
        const thread = this._pushThread(id, candidate);
        thread.executableHat = spec.executable;
        started.push(thread);
      }
    }
    for (const thread of started) if (thread.executableHat) this.sequencer.stepThread(thread);
    return started;
  }`;
}

function resolvePath(source, importer) {
  if (!source.startsWith('.')) return source;
  const parts = importer.split('/'); parts.pop();
  for (const part of source.split('/')) {
    if (part === '..') parts.pop(); else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

function referencedMembers(code) {
  const result = new Map();
  traverse(parseCode(code), {MemberExpression(p) {
    const node = p.node;
    if (!t.isMemberExpression(node.object) || node.computed || node.object.computed) return;
    if (!t.isIdentifier(node.object.object, {name: 'runtime'})) return;
    const name = node.object.property.name;
    if (!name.startsWith('ext_')) return;
    if (!result.has(name)) result.set(name, new Set());
    result.get(name).add(node.property.name);
  }});
  return result;
}

function pruneClass(tree, roots, diagnostics, id) {
  const cls = tree.program.body.find(n => t.isClassDeclaration(n));
  if (!cls) return;
  const keep = new Set(['constructor', ...roots]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const member of cls.body.body) if (keep.has(keyName(member))) {
      t.traverseFast(member, node => {
        if (!t.isMemberExpression(node) || !(t.isThisExpression(node.object) ||
          t.isIdentifier(node.object, {name: cls.id.name}))) return;
        const name = node.computed ? t.isStringLiteral(node.property) && node.property.value : node.property.name;
        if (!name) {
          // Reflection inside the retained implementation prevents safe member elimination.
          for (const other of cls.body.body) if (!keep.has(keyName(other))) { keep.add(keyName(other)); changed = true; }
        } else if (!keep.has(name)) { keep.add(name); changed = true; }
      });
    }
  }
  for (const member of cls.body.body) {
    (keep.has(keyName(member)) ? diagnostics.retainedMembers : diagnostics.removedMembers).push(`${id}#${keyName(member)}`);
  }
  cls.body.body = cls.body.body.filter(member => keep.has(keyName(member)));
}

const internalProperties = [
  '__spPC', '__spSlots', '__spArgs', '__spReturn', '__spFrames', '__spLifetime', '__spUtility',
  '__spTarget', '__spStuck', '__spInitialize', '__spPrimitive', '__spResumedPromise',
  '__spWorkers', '__spDisposed', '__spVariables'
];

// Reviewed against the production Thread/Sequencer definitions and their callers
// in Runtime, execute, block utilities and the pause addon. These objects never
// cross the player/extension RPC boundary. Ambiguous fields such as status,
// target, runtime and value intentionally remain outside this manifest.
const schedulingProperties = {
  Sequencer: ['stepThread', 'stepThreads', 'retireThread'],
  Thread: ['getIdFromTargetAndBlock', 'pushStack', 'popStack', 'reuseStackForNextBlock',
    'peekStack', 'peekStackFrame', 'peekParentStackFrame', 'pushReportedValue',
    'atStackTop', 'goToNextBlock', 'isRecursiveCall']
};
const schedulingArity = {stepThread: 1, retireThread: 1, getIdFromTargetAndBlock: 2,
  pushStack: 1, reuseStackForNextBlock: 1, pushReportedValue: 1, isRecursiveCall: 1};

export function renameProperties(tree, seed, diagnostics, generatedProperties = [], aggressiveProperties = [], reservedProperties = []) {
  const declaredProperties = [...new Set([...internalProperties, ...Object.values(schedulingProperties).flat(),
    ...generatedProperties, ...aggressiveProperties])];
  const schedulingOwner = new Map(Object.entries(schedulingProperties).flatMap(([owner, names]) => names.map(name => [name, owner])));
  const candidates = new Set(declaredProperties);
  const occupied = new Set();
  const reasons = new Map();
  const classes = new Map(), parameters = new Map();
  // Markers are inserted into the known source modules before Rollup. Resolve
  // bindings after linking instead of trusting a class/parameter's spelling.
  traverse(tree, {
    ClassMethod(p) {
      const family = Object.keys(schedulingProperties).find(name => keyName(p.node) === `__spOwner${name}`);
      if (!family) return;
      classes.set(p.findParent(parent => parent.isClass()).node, family); p.remove();
    },
    ExpressionStatement(p) {
      const value = p.node.expression;
      if (!t.isAssignmentExpression(value) || !t.isMemberExpression(value.left) ||
          value.left.property.name !== '__spOwnerExecute' || !t.isIdentifier(value.left.object)) return;
      const binding = p.scope.getBinding(value.left.object.name);
      if (!binding?.path.isFunctionDeclaration()) throw new Error('Monitor execution ownership marker lost its binding');
      const params = binding.path.node.params;
      if (params.length !== 2 || !params.every(param => t.isIdentifier(param))) {
        throw new Error('Monitor execution parameters changed; review scheduling ownership');
      }
      parameters.set(params[0], 'Sequencer'); parameters.set(params[1], 'Thread'); p.remove();
    }
  });
  for (const [cls, family] of classes) {
    if (family !== 'Sequencer') continue;
    for (const method of cls.body.body) {
      if (['stepThread', 'retireThread', ...generatedProperties].includes(keyName(method)) && method.params?.length) {
        parameters.set(method.params[0], 'Thread');
      }
    }
  }
  const reserve = (name, reason) => {
    if (!declaredProperties.includes(name)) return;
    candidates.delete(name);
    if (!reasons.has(name)) reasons.set(name, new Set());
    reasons.get(name).add(reason);
  };
  for (const name of reservedProperties) reserve(name, 'native API, serialized project or public player/extension property');
  const isReflector = (node, p, seen = new Set()) => {
    if (!t.isIdentifier(node)) return false;
    const binding = p.scope.getBinding(node.name);
    if (!binding) return node.name === 'Object' || node.name === 'Reflect';
    if (!binding.constant || seen.has(binding) || !binding.path.isVariableDeclarator()) return false;
    seen.add(binding);
    return isReflector(binding.path.node.init, binding.path, seen);
  };
  // This is a conservative escape check, not inference of rename ownership from
  // a variable name. Ownership comes from the explicit manifest above.
  const familyOf = (node, p, seen = new Set()) => {
    if (t.isClassExpression(node)) return classes.get(node);
    if (t.isThisExpression(node)) {
      const fn = p.isClassMethod() ? p : p.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression());
      const cls = fn?.isClassMethod() && fn.findParent(parent => parent.isClass());
      return cls && classes.get(cls.node);
    }
    if (t.isIdentifier(node)) {
      const binding = p.scope.getBinding(node.name);
      if (binding && !binding.constant) return;
      if (binding && parameters.has(binding.identifier)) return parameters.get(binding.identifier);
      if (binding?.path.isClass()) return classes.get(binding.path.node);
      if (binding && !seen.has(binding) && binding.path.isVariableDeclarator()) {
        seen.add(binding);
        const family = familyOf(binding.path.node.init, binding.path, seen);
        if (family) return family;
        const loop = binding.path.parentPath.parentPath;
        if (loop.isForOfStatement() && t.isMemberExpression(loop.node.right) &&
            !loop.node.right.computed && loop.node.right.property.name === 'threads') return 'Thread';
      }
    }
    if (t.isNewExpression(node) && t.isIdentifier(node.callee)) {
      return familyOf(node.callee, p, seen);
    }
    if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
      if (node.property.name === 'sequencer') return 'Sequencer';
      if (node.property.name === 'thread' || node.property.name === 'activeThread') return 'Thread';
    }
    if ((t.isCallExpression(node) || t.isOptionalCallExpression(node)) &&
        (t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee)) &&
        node.callee.property.name === 'getPrototypeOf' && isReflector(node.callee.object, p)) return familyOf(node.arguments[0], p, seen);
  };
  const reserveFamily = (node, p, reason) => {
    const possible = new Set(), seen = new Set();
    const collect = (value, path) => {
      const family = familyOf(value, path);
      if (family) possible.add(family);
      if (!t.isIdentifier(value)) return;
      const binding = path.scope.getBinding(value.name);
      if (!binding || seen.has(binding)) return;
      seen.add(binding);
      if (parameters.has(binding.identifier)) possible.add(parameters.get(binding.identifier));
      if (binding.path.isVariableDeclarator()) collect(binding.path.node.init, binding.path);
      for (const violation of binding.constantViolations) {
        if (violation.isAssignmentExpression()) collect(violation.node.right, violation);
      }
    };
    collect(node, p);
    for (const family of possible) for (const name of schedulingProperties[family]) reserve(name, reason);
  };
  // Any string-based reflection of an owned name makes it ineligible for this build.
  traverse(tree, {
    StringLiteral(p) {
      occupied.add(p.node.value);
      reserve(p.node.value, 'string access, reflection or externally observable literal');
    },
    Identifier(p) { occupied.add(p.node.name); },
    'CallExpression|OptionalCallExpression'(p) {
      if (!t.isMemberExpression(p.node.callee) && !t.isOptionalMemberExpression(p.node.callee)) return;
      const method = p.node.callee.property.name;
      if (['hasOwnProperty', 'propertyIsEnumerable'].includes(method)) {
        reserveFamily(p.node.callee.object, p, 'reflected scheduling receiver');
      }
      if (method === 'call' && t.isMemberExpression(p.node.callee.object) &&
          ['hasOwnProperty', 'propertyIsEnumerable'].includes(p.node.callee.object.property.name)) {
        reserveFamily(p.node.arguments[0], p, 'reflected scheduling receiver');
      }
      if (!isReflector(p.node.callee.object, p)) return;
      if (['keys', 'values', 'entries', 'ownKeys', 'getOwnPropertyNames', 'getOwnPropertyDescriptors'].includes(method)) {
        reserveFamily(p.node.arguments[0], p, 'enumeration of an internal scheduling object');
      }
      if (!['defineProperty', 'defineProperties', 'getOwnPropertyDescriptor', 'hasOwnProperty', 'hasOwn', 'has', 'deleteProperty', 'get', 'set'].includes(method)) return;
      for (const argument of p.node.arguments) if (t.isStringLiteral(argument)) reserve(argument.value, 'reflected property name');
      if (!t.isStringLiteral(p.node.arguments[1])) reserveFamily(p.node.arguments[0], p, 'dynamic reflection on an internal scheduling object');
    },
    BinaryExpression(p) {
      if (p.node.operator === 'in') reserveFamily(p.node.right, p, 'dynamic property membership on an internal scheduling object');
    },
    ForInStatement(p) { reserveFamily(p.node.right, p, 'enumeration of an internal scheduling object'); },
    'MemberExpression|OptionalMemberExpression'(p) {
      if (!p.node.computed) {
        const name = p.node.property.name;
        if (schedulingOwner.has(name) && familyOf(p.node.object, p) !== schedulingOwner.get(name)) {
          reserve(name, 'receiver outside the audited scheduling object families');
          diagnostics.unprovenSchedulingReceivers ||= {};
          const receivers = diagnostics.unprovenSchedulingReceivers[name] ||= [];
          const receiver = generate(p.node.object).code;
          if (!receivers.includes(receiver)) receivers.push(receiver);
        }
        return;
      }
      if (t.isStringLiteral(p.node.property)) reserve(p.node.property.value, 'computed string access');
      else reserveFamily(p.node.object, p, 'dynamic access to an internal scheduling object');
    },
    'ObjectProperty|ObjectMethod|ClassMethod'(p) {
      const name = keyName(p.node), owner = schedulingOwner.get(name);
      if (!owner) return;
      if (p.isClassMethod() && familyOf(t.thisExpression(), p) === owner) return;
      if (p.parentPath.isObjectPattern() && p.parentPath.parentPath.isVariableDeclarator() &&
          familyOf(p.parentPath.parentPath.node.init, p) === owner) return;
      reserve(name, 'declaration or destructuring outside the audited scheduling object families');
    }
  });
  const map = Object.create(null);
  let index = 0;
  for (const key of candidates) {
    let name;
    do { name = `_p${seedNumber(`${seed}:${index++}`).toString(36)}`; } while (occupied.has(name));
    map[key] = name; occupied.add(name);
  }
  traverse(tree, {
    'MemberExpression|OptionalMemberExpression'(p) {
      if (!p.node.computed && map[p.node.property.name]) p.node.property.name = map[p.node.property.name];
    },
    'ObjectProperty|ObjectMethod|ClassMethod'(p) {
      const name = keyName(p.node);
      if (!p.node.computed && map[name]) { p.node.key = t.identifier(map[name]); p.node.shorthand = false; }
    }
  });
  diagnostics.propertyMap = map;
  diagnostics.reservedProperties = declaredProperties.filter(key => !candidates.has(key));
  diagnostics.reservedPropertyReasons = Object.fromEntries([...reasons].map(([name, entries]) => [name, [...entries].sort()]));
  diagnostics.schedulingProperties = Object.fromEntries(Object.entries(schedulingProperties).map(([owner, names]) =>
    [owner, names.map(name => ({name, renamed: map[name] || null, reasons: diagnostics.reservedPropertyReasons[name] || []}))]));
  diagnostics.aggressiveProperties = aggressiveProperties.map(name =>
    ({name, renamed: map[name] || null, reasons: diagnostics.reservedPropertyReasons[name] || []}));
  diagnostics.propertyBoundary = 'Declared continuation, lifecycle, target-identity and audited Thread/Sequencer methods share one mapping. Ambiguous legacy VM, host API and RPC shapes retain stable keys.';
}

export function auditArtifact(code, {allowGenerators = false} = {}) {
  const violations = [];
  const dynamicCallee = (node, scope, seen = new Set()) => {
    if (t.isSequenceExpression(node)) return dynamicCallee(node.expressions.at(-1), scope, seen);
    if (t.isIdentifier(node)) {
      const binding = scope.getBinding(node.name);
      if (!binding) return ['eval', 'Function', 'scopedEval', 'importScripts'].includes(node.name) ? node.name : null;
      if (seen.has(binding) || !binding.constant || !binding.path.isVariableDeclarator()) return null;
      seen.add(binding);
      return dynamicCallee(binding.path.node.init, binding.path.scope, seen);
    }
    if (t.isMemberExpression(node)) {
      const name = node.computed ? t.isStringLiteral(node.property) && node.property.value : node.property.name;
      if (['eval', 'Function', 'importScripts'].includes(name)) return name;
      if (name === 'call' || name === 'apply' || name === 'bind') return dynamicCallee(node.object, scope, seen);
    }
    return null;
  };
  traverse(parseCode(code), {
    'CallExpression|NewExpression'(p) {
      const callee = p.node.callee;
      const dynamic = dynamicCallee(callee, p.scope);
      if (dynamic) violations.push(dynamic);
      if (t.isImport(callee)) violations.push('runtime import');
      if (t.isIdentifier(callee) && ['setTimeout', 'setInterval'].includes(callee.name) && t.isStringLiteral(p.node.arguments[0])) violations.push('timer code string');
    },
    Function(p) { if (p.node.generator && !allowGenerators) violations.push('generator'); }
  });
  if (violations.length) throw new Error(`Specialized artifact contains forbidden execution paths: ${[...new Set(violations)].join(', ')}`);
}

export async function linkPlayer({sourcePack, program, input, boot, seed, minifyOutput = true, sourceMap: wantSourceMap = false,
  aggressiveRenaming = false, addons = {}}, rollup) {
  if (typeof aggressiveRenaming !== 'boolean') throw new Error('aggressiveRenaming must be a boolean');
  if (!sourcePack || sourcePack.version !== 1) throw new Error('Runtime source pack is missing or incompatible');
  const sources = {...sourcePack.sources};
  // Seed-permuted regions get dense local PCs and an encoded group number.
  // Both dispatch levels can use jump tables instead of comparing every range.
  const layout = dispatchGroups(program.blocks);
  const pcMap = new Map(layout.flatMap((group, index) => group.map((block, offset) =>
    [block.id, (index + 1) * 256 + offset])));
  const rewritePC = node => {
    if (t.isNumericLiteral(node) && pcMap.has(node.value)) node.value = pcMap.get(node.value);
    else if (t.isConditionalExpression(node)) { rewritePC(node.consequent); rewritePC(node.alternate); }
  };
  program = {...program, hats: program.hats.map(hat => ({...hat, pc: pcMap.get(hat.pc)})), blocks: program.blocks.map(block => {
    const tree = parseCode(`function region() { __spRun: while (true) { ${block.code.join('\n')} } }`);
    traverse(tree, {
      AssignmentExpression(p) {
        if (t.isMemberExpression(p.node.left) && p.node.left.property.name === '__spPC') rewritePC(p.node.right);
      },
      ObjectProperty(p) { if (keyName(p.node) === '__spPC') rewritePC(p.node.value); }
    });
    return {...block, id: pcMap.get(block.id), dispatchGroup: pcMap.get(block.id) >>> 8,
      code: tree.program.body[0].body.body[0].body.body.body.map(node => print(t.file(t.program([node]))))};
  })};
  const diagnostics = {retainedMembers: [], removedMembers: [], retainedModules: [], removedModules: [],
    continuationCount: program.blocks.length, scriptCount: program.hats.length, runtimeFingerprint: sourcePack.fingerprint,
    aggressiveRenaming};
  if (input.project.targets.some(target => Object.keys(target.blocks).length || Object.keys(target.comments).length)) {
    throw new Error('Player initial data must not contain source blocks or comments');
  }
  diagnostics.slotMaps = program.slotMaps;
  diagnostics.dispatchGroups = [];
  for (const regions of dispatchGroups(program.blocks)) {
    diagnostics.dispatchGroups.push({regionCount: regions.length, entries: [...new Set(regions.map(region => region.owner))],
      sourceLength: regions.reduce((sum, region) => sum + region.code.join('\n').length, 0),
      includesLifecycle: regions.some(region => region.code.some(source => /retireThread|__spLifetime|__spFrames\.pop/.test(source)))});
  }
  const find = suffix => Object.keys(sources).find(id => (sourcePack.provenance[id] || []).some(origin => origin.endsWith(suffix)));
  const runtimeId = find('scratch-vm/src/engine/runtime.js');
  const sequencerId = find('scratch-vm/src/engine/sequencer.js');
  if (!runtimeId || !sequencerId) throw new Error('Source pack does not contain the production runtime');
  for (const family of Object.keys(schedulingProperties)) {
    const id = find(`scratch-vm/src/engine/${family.toLowerCase()}.js`);
    if (!id) throw new Error(`Source pack is missing audited ${family}`);
    const tree = parseCode(sources[id]);
    const cls = tree.program.body.find(node => t.isClassDeclaration(node) && node.id.name === family);
    if (!cls || schedulingProperties[family].some(name => {
      const method = cls.body.body.find(member => keyName(member) === name);
      return !method || method.params.length !== (schedulingArity[name] || 0) ||
        !method.params.every(param => t.isIdentifier(param)) || method.async || method.generator ||
        method.static !== (name === 'getIdFromTargetAndBlock');
    })) {
      throw new Error(`${family} methods changed; review the scheduling property manifest`);
    }
    const marker = t.classMethod('method', t.identifier(`__spOwner${family}`), [], t.blockStatement([]));
    marker.static = true; cls.body.body.push(marker); sources[id] = print(tree);
  }
  const executeId = find('scratch-vm/src/engine/execute.js');
  if (!executeId) throw new Error('Source pack is missing monitor execution');
  sources[executeId] += '\nexecute.__spOwnerExecute = true;';
  const helpers = parseCode(sourcePack.helpers);
  const helperNames = helpers.program.body.flatMap(n => t.isExportNamedDeclaration(n) && t.isVariableDeclaration(n.declaration) ?
    n.declaration.declarations.map(d => d.id.name) : []);
  sources['specialized-helpers.js'] = sourcePack.helpers;
  const methods = stepMethods(program.blocks);
  const step = Object.entries(methods).map(([name, body]) => `function ${name}(thread) ${body}`).join('\n');
  const roots = referencedMembers(step);
  const extensionIDs = input.extensions || [];
  const audioReasons = [];
  if (roots.has('ext_scratch3_sound')) audioReasons.push('sound operations');
  if (input.project.targets.some(target => target.sounds.length)) audioReasons.push('sound assets');
  if (extensionIDs.some(id => ['music', 'text2speech'].includes(id))) audioReasons.push('audio extension');
  if (/getLoudness/.test(step) || (input.project.monitors || []).some(m => m.opcode === 'sensing_loudness')) audioReasons.push('microphone input');
  const videoReasons = extensionIDs.includes('videoSensing') ? ['video sensing extension'] : [];
  const audio = audioReasons.length > 0;
  const video = videoReasons.length > 0;
  diagnostics.capabilities = {audio: audioReasons, video: videoReasons,
    pen: extensionIDs.includes('pen') ? ['pen extension'] : []};
  const rendererId = find('node_modules/scratch-render/src/RenderWebGL.js');
  if (rendererId) {
    const tree = parseCode(sources[rendererId]);
    traverse(tree, {
      ExpressionStatement(p) {
        const expression = p.node.expression;
        if (t.isAssignmentExpression(expression) && t.isMemberExpression(expression.left) &&
          t.isThisExpression(expression.left.object) && expression.left.property.name === 'exports') p.remove();
      },
      ClassMethod(p) {
        if (keyName(p.node) === 'exports' || (!extensionIDs.includes('pen') &&
          ['createPenSkin', 'penClear', 'penPoint', 'penLine', 'penStamp'].includes(keyName(p.node)))) p.remove();
      },
      IfStatement(p) {
        if (!extensionIDs.includes('pen') && t.isBinaryExpression(p.node.test) &&
          t.isMemberExpression(p.node.test.left) && p.node.test.left.property.name === '_penSkinId') p.remove();
      }
    });
    removeUnusedImports(tree); sources[rendererId] = print(tree);
  }
  const librariesId = find('tw-packager/src/scaffolding/scratch-libraries.js');
  if (librariesId && !audio) {
    const tree = parseCode(sources[librariesId]);
    tree.program.body = tree.program.body.filter(node => !t.isExportNamedDeclaration(node) ||
      !node.specifiers.some(specifier => specifier.exported.name === 'AudioEngine'));
    sources[librariesId] = print(tree);
  }
  const scaffoldingId = find('tw-packager/src/scaffolding/scaffolding.js');
  if (scaffoldingId) {
    const tree = parseCode(sources[scaffoldingId]);
    if (!audio) for (const node of tree.program.body) {
      if (t.isExportNamedDeclaration(node)) node.specifiers = node.specifiers.filter(specifier => specifier.exported.name !== 'AudioEngine');
    }
    traverse(tree, {
      IfStatement(p) {
        if (!audio && print(t.file(t.program([p.node]))).includes('new AudioEngine(')) p.remove();
      },
      ExpressionStatement(p) {
        const value = p.node.expression;
        if (!video && t.isAssignmentExpression(value) && t.isMemberExpression(value.left) &&
          value.left.property.name === 'videoProvider') p.remove();
        if (!video && t.isCallExpression(value) && t.isMemberExpression(value.callee) && value.callee.property.name === 'setVideoProvider') p.remove();
      }
    });
    removeUnusedImports(tree); sources[scaffoldingId] = print(tree);
  }
  const requiredPrimitives = new Set(program.primitives);
  for (const hat of program.hats) requiredPrimitives.add(hat.opcode);
  for (const monitor of input.project.monitors || []) requiredPrimitives.add(monitor.opcode);
  // show/hide can reveal initially hidden variable/list monitors after startup.
  requiredPrimitives.add('data_variable'); requiredPrimitives.add('data_listcontents');
  const primitiveBindings = new Map();
  const blockClasses = new Map();
  const aggressiveProperties = new Set();
  for (const id of Object.keys(sources)) {
    const origins = sourcePack.provenance[id] || [];
    const origin = origins.find(name => /scratch-vm\/src\/(blocks\/scratch3_|extensions\/)/.test(name));
    if (!origin || !sources[id].includes('class ')) continue;
    const tree = parseCode(sources[id]);
    const cls = tree.program.body.find(n => t.isClassDeclaration(n));
    if (!cls) continue;
    const builtin = origin.match(/blocks\/(scratch3_\w+)\.js$/);
    const extension = origin.match(/extensions\/scratch3_([^/]+)\/index.js$/);
    const name = builtin ? builtin[1] : extension && extension[1];
    if (!name) continue;
    const field = `ext_${name}`;
    const method = cls.body.body.find(n => keyName(n) === 'getPrimitives');
    if (method) t.traverseFast(method, node => {
      if (!t.isObjectProperty(node)) return;
      const opcode = keyName(node);
      if (requiredPrimitives.has(opcode)) {
        let implementation;
        if (t.isMemberExpression(node.value) && t.isThisExpression(node.value.object) && !node.value.computed) {
          implementation = node.value.property.name;
        } else if ((t.isArrowFunctionExpression(node.value) || t.isFunctionExpression(node.value) && !node.value.id) &&
            method.body.body.length === 1 && t.isReturnStatement(method.body.body[0])) {
          // Legacy no-op primitives can be inline functions instead of methods.
          // Move them into the same class so lexical `this` and direct calls agree.
          implementation = `_inline${seedNumber(`${seed}:${opcode}`).toString(36)}`;
          const value = node.value;
          const member = t.classMethod('method', t.identifier(implementation), value.params,
            t.isBlockStatement(value.body) ? value.body : t.blockStatement([t.returnStatement(value.body)]));
          member.async = value.async; member.generator = value.generator || false;
          cls.body.body.push(member);
        } else {
          throw new Error(`Cannot statically bind builtin primitive ${opcode}`);
        }
        primitiveBindings.set(opcode, {field, method: implementation});
        if (!roots.has(field)) roots.set(field, new Set());
        roots.get(field).add(implementation);
      }
    });
    blockClasses.set(field, {id, tree, builtin: Boolean(builtin)});
  }
  // Only selected builtin extensions are initialized. Their getInfo/registration hooks remain roots.
  for (const extension of input.extensions || []) {
    const field = `ext_${extension}`;
    if (!roots.has(field)) roots.set(field, new Set());
    roots.get(field).add('getInfo');
  }
  for (const [field, item] of blockClasses) {
    if (!roots.has(field)) continue;
    const selected = roots.get(field);
    if (!item.builtin) {
      const cls = item.tree.program.body.find(node => t.isClassDeclaration(node));
      const info = cls.body.body.find(node => keyName(node) === 'getInfo');
      let blockArray;
      if (info) t.traverseFast(info, node => {
        if (t.isObjectProperty(node) && keyName(node) === 'blocks' && t.isArrayExpression(node.value)) blockArray = node.value;
      });
      const staticBlocks = blockArray && blockArray.elements.every(node => t.isStringLiteral(node) ||
        t.isObjectExpression(node) && node.properties.every(t.isObjectProperty) && node.properties.every(property =>
          !['opcode', 'func'].includes(keyName(property)) || t.isStringLiteral(property.value)));
      if (!staticBlocks) {
        diagnostics.retainedMembers.push(`${item.id}#dynamic-extension-registration`);
        continue;
      }
      const extension = field.slice(4);
      blockArray.elements = blockArray.elements.filter(node => {
        if (!t.isObjectExpression(node)) return false;
        const opcode = node.properties.find(property => keyName(property) === 'opcode')?.value.value;
        if (!opcode || !requiredPrimitives.has(`${extension}_${opcode}`)) return false;
        selected.add(node.properties.find(property => keyName(property) === 'func')?.value.value || opcode);
        return true;
      });
      // Dynamic menu providers and callback names are protocol fields. Retain
      // their methods when registration metadata mentions them as strings.
      const methods = new Set(cls.body.body.map(keyName));
      t.traverseFast(info, node => { if (t.isStringLiteral(node) && methods.has(node.value)) selected.add(node.value); });
      pruneClass(item.tree, selected, diagnostics, item.id);
      removeUnusedImports(item.tree);
      sources[item.id] = print(item.tree);
      continue;
    }
    if (requiredPrimitives.size) selected.add('getMonitored');
    pruneClass(item.tree, selected, diagnostics, item.id);
    if (aggressiveRenaming) {
      // Core packages are registered with static assignments below, so their
      // runtime fields and private methods can share the program's property map.
      // Keep public registration hooks and opcode/RPC metadata stable. Literal
      // access and reflection still reserve names in renameProperties.
      aggressiveProperties.add(field);
      const cls = item.tree.program.body.find(node => t.isClassDeclaration(node));
      for (const member of cls.body.body) {
        const name = keyName(member);
        if (t.isClassMethod(member) && !member.computed && /^_(?!_)/.test(name)) aggressiveProperties.add(name);
      }
    }
    removeUnusedImports(item.tree);
    sources[item.id] = print(item.tree);
  }
  const runtimeTree = parseCode(sources[runtimeId]);
  if (!video) traverse(runtimeTree, {NewExpression(p) {
    if (t.isIdentifier(p.node.callee, {name: 'Video'})) p.replaceWith(t.nullLiteral());
  }});
  const runtimeClass = runtimeTree.program.body.find(n => t.isClassDeclaration(n));
  const packages = runtimeTree.program.body.filter(t.isVariableDeclaration).flatMap(n => n.declarations)
    .find(n => t.isIdentifier(n.id, {name: 'defaultBlockPackages'}));
  if (!packages) throw new Error('Source pack block registry changed');
  const registrations = [];
  packages.init.properties = packages.init.properties.filter(property => {
    const name = keyName(property); const field = `ext_${name}`;
    if (!roots.has(field)) return false;
    registrations.push(`this.${field} = new ${print(t.file(t.program([t.expressionStatement(property.value)]))).replace(/;$/, '')}(this);`);
    return true;
  });
  const hatsMetadata = Object.fromEntries(program.hats.map(hat => [hat.opcode, hat.metadata]));
  for (const [index, member] of runtimeClass.body.body.entries()) {
    const name = keyName(member);
    if (name === '_registerBlockPackages') runtimeClass.body.body[index] = parseMethod(`_registerBlockPackages() {
      ${registrations.join('\n')}
      this._hats = ${q(hatsMetadata)};
      ${[...roots.keys()].filter(name => blockClasses.get(name)?.builtin).map(name =>
        `if (this.${name}.getMonitored) Object.assign(this.monitorBlockInfo, this.${name}.getMonitored());`).join('\n')}
    }`);
    if (name === 'startHats') runtimeClass.body.body[index] = parseMethod(`startHats(opcode, fields, target) ${hatsBody(program.hats)}`);
    if (name === '__spPrimitive') runtimeClass.body.body[index] = parseMethod(`__spPrimitive(opcode, args, utility) {
      switch (opcode) {${[...primitiveBindings].map(([opcode, binding]) => `case ${q(opcode)}: return this.${binding.field}.${binding.method}(args, utility);`).join('\n')}
      default: {
        const primitive = this._primitives[opcode];
        if (!primitive) throw new Error('Unlinked primitive: ' + opcode);
        return primitive(args, utility);
      }}
    }`);
  }
  removeUnusedImports(runtimeTree);
  sources[runtimeId] = print(runtimeTree);
  const sequenceTree = parseCode(sources[sequencerId]);
  sequenceTree.program.body.unshift(t.importDeclaration(helperNames.map(name => t.importSpecifier(t.identifier(name), t.identifier(name))), t.stringLiteral('specialized-helpers.js')));
  const sequenceClass = sequenceTree.program.body.find(n => t.isClassDeclaration(n));
  const stepIndex = sequenceClass.body.body.findIndex(n => keyName(n) === 'stepThread');
  sequenceClass.body.body.splice(stepIndex, 1, ...Object.entries(methods).map(([name, body]) => parseMethod(`${name}(thread) ${body}`)));
  diagnostics.cachedScalars = cachePureComputation(sequenceTree, program.blocks);
  sources[sequencerId] = print(sequenceTree);
  const extensionId = find('scratch-vm/src/extension-support/extension-manager.js');
  if (extensionId) {
    const tree = parseCode(sources[extensionId]);
    traverse(tree, {VariableDeclarator(p) {
      if (p.node.id.name !== 'defaultBuiltinExtensions') return;
      p.node.init.properties = p.node.init.properties.filter(prop => input.extensions.includes(keyName(prop)));
    }});
    const cls = tree.program.body.find(node => t.isClassDeclaration(node));
    const index = cls.body.body.findIndex(node => keyName(node) === 'loadExtensionURL');
    cls.body.body[index] = parseMethod(`async loadExtensionURL(url) ${extensionLoaderBody(input.fixedExtensions || [])}`);
    removeUnusedImports(tree);
    sources[extensionId] = print(tree);
  }
  diagnostics.fixedExtensions = (input.fixedExtensions || []).map(extension => ({
    buildId: extension.token, ids: extension.infos.map(info => info.id), dependencies: extension.dependencies,
    boundary: 'isolated worker; no VM or compiler access'}));
  const addonId = find('tw-packager/src/addons/index.js');
  if (addonId) {
    const tree = parseCode(sources[addonId]);
    traverse(tree, {IfStatement(p) {
      if (t.isMemberExpression(p.node.test) && t.isIdentifier(p.node.test.object, {name: 'options'})) {
        if (addons[p.node.test.property.name]) p.replaceWith(p.node.consequent); else p.remove();
      }
    }});
    removeUnusedImports(tree);
    sources[addonId] = print(tree);
  }
  const gamepadId = find('tw-packager/src/addons/gamepad/userscript.js');
  if (gamepadId && addons.gamepad) {
    const tree = parseCode(sources[gamepadId]);
    traverse(tree, {VariableDeclarator(p) {
      if (p.node.id.name === 'getKeysUsedByProject') p.node.init = parseCode(
        `const f = () => new Set(${q(input.addons.usedKeys)}.map(scratchKeyToKey));`).program.body[0].declarations[0].init;
      if (p.node.id.name === 'parseOptionsComment') p.node.init = parseCode(
        `const f = () => (${q(input.addons.gamepadSettings)});`).program.body[0].declarations[0].init;
    }});
    sources[gamepadId] = print(tree);
  }
  const entry = 'specialized-boot.js';
  sources[entry] = `import {Scaffolding, ScaffoldingAddons} from ${q(sourcePack.entry)};\n${boot}`;
  if (aggressiveRenaming) {
    if (!sourcePack.platformProperties?.length) throw new Error('Rebuild the runtime source pack for expanded aggressive renaming');
    const families = /scratch-vm\/src\/(engine\/(runtime|thread|sequencer|target|variable)|sprites\/(rendered-target|sprite)|blocks\/scratch3_\w+)\.js$/;
    diagnostics.threadStatusAccesses = 0;
    for (const id of Object.keys(sources)) {
      const origins = sourcePack.provenance[id] || [];
      const origin = origins.find(name => families.test(name));
      const statusSource = origins.find(name => /scratch-vm\/src\/engine\/(thread|sequencer|runtime|execute|block-utility)\.js$/.test(name) ||
        name.endsWith('scratch-vm/src/blocks/scratch3_procedures.js') || name.endsWith('tw-packager/src/addons/pause.js'));
      if (!origin && !statusSource) continue;
      const tree = parseCode(sources[id]);
      if (origin) for (const name of collectVMProperties(tree)) aggressiveProperties.add(name);
      if (statusSource) diagnostics.threadStatusAccesses += rewriteThreadStatus(tree, statusSource);
      sources[id] = print(tree);
    }
    aggressiveProperties.add(threadStatusProperty);
  }
  const importedBy = new Map();
  const bundle = await rollup({input: entry, treeshake: {moduleSideEffects: true},
    onwarn(warning) { if (!['CIRCULAR_DEPENDENCY', 'THIS_IS_UNDEFINED'].includes(warning.code)) throw new Error(warning.message); },
    plugins: [{name: 'specialized-memory', resolveId(source, importer) {
      const id = resolvePath(source, importer || entry);
      if (!Object.hasOwn(sources, id)) throw new Error(`Unresolved runtime module ${source} from ${importer}`);
      return id;
    }, load(id) { return sources[id]; }, moduleParsed(info) {
      for (const imported of info.importedIds) {
        if (!importedBy.has(imported)) importedBy.set(imported, []);
        importedBy.get(imported).push(info.id);
      }
    }}]});
  try {
    const generated = await bundle.generate({format: 'iife', inlineDynamicImports: true, generatedCode: 'es2015', sourcemap: wantSourceMap ? 'hidden' : false});
    const chunk = generated.output[0];
    for (const id of Object.keys(sourcePack.sources)) {
      (chunk.modules[id]?.renderedLength > 0 ? diagnostics.retainedModules : diagnostics.removedModules).push(id);
    }
    diagnostics.retentionReasons = Object.fromEntries(diagnostics.retainedModules.map(id => [id,
      {importedBy: importedBy.get(id) || [], sideEffects: 'preserved'}]));
    diagnostics.commonJSWrappers = diagnostics.retainedModules.filter(id =>
      /__require/.test(sourcePack.sources[id]) && (chunk.modules[id].renderedExports || []).some(name => name === '__require'))
      .map(id => {
        const audit = sourcePack.wrapperAudit?.[id];
        if (!audit) throw new Error(`Unaudited CommonJS wrapper: ${id}`);
        return {module: id, origins: sourcePack.provenance[id], ...audit};
      });
    for (const item of diagnostics.commonJSWrappers) {
      if (item.origins.some(origin => /^(scratch-vm\/src|tw-packager\/src)\//.test(origin))) {
        throw new Error(`First-party CommonJS factory survived: ${item.module}`);
      }
    }
    const tree = parseCode(chunk.code);
    renameProperties(tree, seed, diagnostics, Object.keys(methods).filter(name => name !== 'stepThread'),
      [...aggressiveProperties].sort(), aggressiveRenaming ? [...sourcePack.platformProperties, ...publicProperties] : []);
    if (aggressiveRenaming) {
      diagnostics.scopedProperties = {'Thread.status': diagnostics.propertyMap[threadStatusProperty]};
      diagnostics.propertyBoundary = 'Expanded aggressive mode renames VM, target, sprite and core block methods and internal fields, including scoped thread status. Native APIs, SB3 state keys and public player/extension protocols retain stable names. Third-party extension compatibility is not guaranteed.';
    }
    const transformed = generate(tree, {comments: false, sourceMaps: wantSourceMap,
      inputSourceMap: wantSourceMap ? chunk.map : undefined, sourceFileName: 'linked-player.js'}, chunk.code);
    let code = transformed.code;
    let sourceMap = transformed.map;
    if (minifyOutput) {
      const result = await minify(code, {compress: {passes: 2}, mangle: {toplevel: true},
        format: {comments: false}, sourceMap: wantSourceMap ? {content: sourceMap, asObject: true, includeSources: true} : false});
      code = result.code;
      if (wantSourceMap) sourceMap = result.map;
    }
    auditArtifact(code);
    return {code, diagnostics, ...(wantSourceMap ? {sourceMap} : {})};
  } finally { await bundle.close(); }
}
