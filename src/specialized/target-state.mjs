import traverseModule from '@babel/traverse';
import * as t from '@babel/types';

const traverse = traverseModule.default || traverseModule;
export const targetFields = ['runtime', 'renderer', 'drawableID', 'variables', 'isStage',
  'x', 'y', 'direction', 'size', 'visible', 'draggable', 'rotationStyle', 'currentCostume',
  'effects', 'volume', 'tempo', 'videoTransparency', 'videoState', 'textToSpeechLanguage', 'isOriginal'];
export const targetProperty = name => `__spState_${name}`;
export const targetStateModule = 'specialized-target-state.js';
export const targetStateNames = '__spTargetStateNames';
export const targetStateSource = `
  const owned = Symbol();
  const external = ${JSON.stringify(targetFields)};
  const internal = ${targetStateNames};
  export const registerTarget = prototype => { Object.defineProperty(prototype, owned, {value: true}); };
  export const stateKey = (object, index) => object != null && object[owned] ? internal[index] : external[index];
`;

// Transform only resolved first-party VM/player modules. Target instance state
// gets private keys; JSON, DOM objects, renderer records and Map.size keep their
// own shapes. There are no compatibility getters on Target to mask missed uses.
export function rewriteTargetState(tree, source) {
  let program;
  traverse(tree, {Program(p) { program = p; p.stop(); }});
  const key = program.scope.generateUidIdentifier('stateKey');
  const register = program.scope.generateUidIdentifier('registerTarget');
  const cls = source.endsWith('scratch-vm/src/engine/target.js') ? 'Target' :
    source.endsWith('scratch-vm/src/sprites/rendered-target.js') ? 'RenderedTarget' : null;
  const ownedThis = p => {
    const fn = p.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression());
    if (!fn?.isClassMethod() || fn.node.static) return false;
    return Boolean(cls && fn.findParent(parent => parent.isClass())?.node.id?.name === cls);
  };
  const knownOtherThis = p => {
    const fn = p.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression());
    return Boolean(fn?.isClassMethod() && !ownedThis(p));
  };
  const knownTarget = (node, p, seen = new Set()) => {
    if (t.isThisExpression(node)) return ownedThis(p);
    if (t.isNewExpression(node) && t.isIdentifier(node.callee, {name: 'RenderedTarget'})) return true;
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && !node.callee.computed &&
        ['getTargetForStage', 'getTargetById', 'getEditingTarget', 'getSpriteTargetByName',
          'getTargetByDrawableId', 'makeClone'].includes(node.callee.property.name)) return true;
    // RenderedTarget.makeClone's this.sprite is the production Sprite; its
    // createClone constructs a registered RenderedTarget. Keep clone state
    // copies direct instead of checking the same new object for every field.
    if (source.endsWith('scratch-vm/src/sprites/rendered-target.js') && ownedThis(p) &&
        t.isCallExpression(node) && t.isMemberExpression(node.callee) && !node.callee.computed &&
        node.callee.property.name === 'createClone' && t.isMemberExpression(node.callee.object) &&
        !node.callee.object.computed && node.callee.object.property.name === 'sprite' &&
        t.isThisExpression(node.callee.object.object)) return true;
    if (t.isMemberExpression(node) && !node.computed && node.property.name === 'target' &&
        t.isIdentifier(node.object, {name: 'thread'}) && source.endsWith('scratch-vm/src/engine/sequencer.js')) return true;
    if (t.isIdentifier(node)) {
      const binding = p.scope.getBinding(node.name);
      if (!binding?.constant || seen.has(binding) || !binding.path.isVariableDeclarator()) return false;
      seen.add(binding);
      return knownTarget(binding.path.node.init, binding.path, seen);
    }
    return false;
  };
  const indexOf = node => {
    const value = t.isIdentifier(node) ? node.name : t.isStringLiteral(node) ? node.value : null;
    return targetFields.indexOf(value);
  };
  let accesses = 0, direct = 0;
  if (cls === 'Target') {
    const declaration = tree.program.body.find(node => t.isClassDeclaration(node) && node.id.name === cls);
    const constructor = declaration?.body.body.find(node => t.isClassMethod(node, {kind: 'constructor'}));
    const superIndex = constructor?.body.body.findIndex(node =>
      t.isExpressionStatement(node) && t.isCallExpression(node.expression) && t.isSuper(node.expression.callee));
    if (!(superIndex >= 0)) throw new Error('Target constructor changed; review state registration');
    // Brand the prototype once. Per-instance WeakSet registration added
    // allocation/GC cost to clone-heavy projects without changing ownership.
    const declarationIndex = tree.program.body.indexOf(declaration);
    tree.program.body.splice(declarationIndex + 1, 0,
      t.expressionStatement(t.callExpression(t.cloneNode(register), [
        t.memberExpression(t.identifier(cls), t.identifier('prototype'))])));
  }
  traverse(tree, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (!t.isMemberExpression(callee) || callee.computed) return;
      let receiver, slot;
      if (['hasOwnProperty', 'propertyIsEnumerable'].includes(callee.property.name)) {
        receiver = callee.object; slot = 0;
      } else if (callee.property.name === 'call' && t.isMemberExpression(callee.object) &&
          ['hasOwnProperty', 'propertyIsEnumerable'].includes(callee.object.property.name)) {
        slot = 1;
      } else if (t.isIdentifier(callee.object) && !p.scope.getBinding(callee.object.name) &&
          ['Object', 'Reflect'].includes(callee.object.name) &&
          ['hasOwn', 'has', 'get', 'set', 'deleteProperty', 'getOwnPropertyDescriptor', 'defineProperty'].includes(callee.property.name)) {
        slot = 1;
      }
      if (slot === undefined || !t.isStringLiteral(p.node.arguments[slot])) return;
      const index = indexOf(p.node.arguments[slot]);
      if (index < 0) return;
      const object = p.scope.generateUidIdentifier('stateObject');
      p.scope.push({id: t.cloneNode(object), kind: 'var'});
      if (receiver) callee.object = t.assignmentExpression('=', t.cloneNode(object), receiver);
      else p.node.arguments[0] = t.assignmentExpression('=', t.cloneNode(object), p.node.arguments[0]);
      p.node.arguments[slot] = t.callExpression(t.cloneNode(key), [t.cloneNode(object), t.numericLiteral(index)]);
      accesses++;
    },
    BinaryExpression(p) {
      if (p.node.operator !== 'in' || !t.isStringLiteral(p.node.left)) return;
      const index = indexOf(p.node.left);
      if (index < 0) return;
      const object = p.scope.generateUidIdentifier('stateObject');
      p.scope.push({id: t.cloneNode(object), kind: 'var'});
      p.replaceWith(t.sequenceExpression([
        t.assignmentExpression('=', t.cloneNode(object), p.node.right),
        t.binaryExpression('in', t.callExpression(t.cloneNode(key), [t.cloneNode(object), t.numericLiteral(index)]), t.cloneNode(object))
      ]));
      accesses++;
    },
    ObjectPattern(p) {
      const properties = p.node.properties.filter(node => t.isObjectProperty(node) && !node.computed && indexOf(node.key) >= 0);
      if (!properties.length) return;
      const declaration = p.parentPath;
      if (!declaration.isVariableDeclarator() || !declaration.node.init || p.node.properties.some(t.isRestElement)) {
        throw new Error(`Unreviewed target state destructuring in ${source}`);
      }
      const receiver = declaration.scope.generateUidIdentifier('stateObject');
      declaration.scope.push({id: t.cloneNode(receiver), kind: 'var'});
      declaration.node.init = t.assignmentExpression('=', t.cloneNode(receiver), declaration.node.init);
      for (const property of properties) {
        property.key = t.callExpression(t.cloneNode(key), [t.cloneNode(receiver), t.numericLiteral(indexOf(property.key))]);
        property.computed = true; property.shorthand = false; accesses++;
      }
    },
    'MemberExpression|OptionalMemberExpression': {exit(p) {
      const node = p.node;
      const index = node.computed ? t.isStringLiteral(node.property) ? indexOf(node.property) : -1 : indexOf(node.property);
      if (index < 0) return;
      if (t.isThisExpression(node.object) && knownOtherThis(p)) return;
      // Multi-link optional chains need explicit lowering before this pass;
      // rejecting a new source shape is safer than changing short-circuiting.
      if (p.isOptionalMemberExpression() && !node.optional) throw new Error(`Unreviewed target state optional chain in ${source}`);
      if (!p.isOptionalMemberExpression() && knownTarget(node.object, p)) {
        node.property = t.identifier(targetProperty(targetFields[index])); node.computed = false;
        accesses++; direct++; return;
      }
      if (t.isSuper(node.object)) throw new Error(`Unreviewed target state super access in ${source}`);
      const receiver = p.scope.generateUidIdentifier('stateObject');
      p.scope.push({id: t.cloneNode(receiver), kind: 'var'});
      node.object = t.assignmentExpression('=', t.cloneNode(receiver), node.object);
      node.property = t.callExpression(t.cloneNode(key), [t.cloneNode(receiver), t.numericLiteral(index)]);
      node.computed = true; accesses++;
    }}
  });
  if (accesses || cls === 'Target') {
    tree.program.body.unshift(t.importDeclaration([
      ...(accesses > direct ? [t.importSpecifier(t.cloneNode(key), t.identifier('stateKey'))] : []),
      ...(cls === 'Target' ? [t.importSpecifier(t.cloneNode(register), t.identifier('registerTarget'))] : [])
    ], t.stringLiteral(targetStateModule)));
  }
  return {accesses, direct};
}

export function finalizeTargetState(tree, propertyMap) {
  traverse(tree, {ReferencedIdentifier(p) {
    if (p.node.name !== targetStateNames || p.scope.getBinding(targetStateNames)) return;
    p.replaceWith(t.arrayExpression(targetFields.map(name =>
      t.stringLiteral(propertyMap[targetProperty(name)] || targetProperty(name)))));
  }});
}
