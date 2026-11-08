import traverseModule from '@babel/traverse';
import * as t from '@babel/types';

const traverse = traverseModule.default || traverseModule;
export const threadStatusProperty = '__spThreadStatus';

// These shapes cross the player, SB3, renderer or extension boundary. Renaming
// an internal method must not change native APIs or serialized project keys.
export const publicProperties = [
  'constructor', 'prototype', 'toJSON', 'runtime', 'vm', 'renderer', 'audioEngine',
  'start', 'stop', 'pause', 'resume', 'postInput', 'on', 'off', 'dispose',
  'getInfo', 'getPrimitives', 'getHats', 'getMonitored',
  'isStage', 'name', 'variables', 'lists', 'broadcasts', 'blocks', 'comments',
  'currentCostume', 'costumes', 'sounds', 'volume', 'layerOrder', 'tempo',
  'videoTransparency', 'videoState', 'textToSpeechLanguage', 'extensionStorage',
  'x', 'y', 'direction', 'size', 'visible', 'draggable', 'rotationStyle',
  'id', 'type', 'value', 'target', 'status'
];

export function collectVMProperties(tree) {
  const names = new Set();
  traverse(tree, {
    ClassMethod(p) {
      if (p.node.computed || p.node.kind === 'constructor') return;
      const name = p.node.key.name;
      if (name && !name.startsWith('__spOwner')) names.add(name);
    },
    MemberExpression(p) {
      if (t.isThisExpression(p.node.object) && !p.node.computed) names.add(p.node.property.name);
    }
  });
  return names;
}

// This source-level manifest is deliberately narrow: every status access in
// these production modules belongs to a thread or the pause addon's saved
// thread state. Run before Rollup, while module and receiver names are stable.
// Reject new receiver shapes instead of silently renaming Response.status.
export function rewriteThreadStatus(tree, source) {
  const pause = source.endsWith('tw-packager/src/addons/pause.js');
  const thread = source.endsWith('scratch-vm/src/engine/thread.js');
  const allowed = pause || /scratch-vm\/src\/engine\/(thread|sequencer|runtime|execute|block-utility)\.js$/.test(source) ||
    source.endsWith('scratch-vm/src/blocks/scratch3_procedures.js');
  if (!allowed) return 0;
  let count = 0;
  traverse(tree, {
    'MemberExpression|OptionalMemberExpression'(p) {
      const key = p.node.computed ? p.node.property.value : p.node.property.name;
      if (key !== 'status') return;
      const receiver = p.node.object;
      const known = t.isIdentifier(receiver) && ['thread', 'activeThread', ...(pause ? ['pauseState'] : [])].includes(receiver.name) ||
        thread && t.isThisExpression(receiver) ||
        t.isMemberExpression(receiver) && (!receiver.computed && receiver.property.name === 'thread' ||
          receiver.computed && t.isMemberExpression(receiver.object) && receiver.object.property.name === 'threads');
      if (!known) throw new Error(`Unreviewed thread status receiver in ${source}`);
      p.node.computed = false;
      p.node.property = t.identifier(threadStatusProperty);
      count++;
    },
    ObjectProperty(p) {
      if ((p.node.computed ? p.node.key.value : p.node.key.name || p.node.key.value) !== 'status') return;
      if (!pause || p.node.computed) throw new Error(`Unreviewed thread status object in ${source}`);
      p.node.key = t.identifier(threadStatusProperty);
      p.node.shorthand = false;
      count++;
    }
  });
  return count;
}
