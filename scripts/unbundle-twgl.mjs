import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
import traverseModule from '@babel/traverse';
import generateModule from '@babel/generator';
import * as t from '@babel/types';

const traverse = traverseModule.default;
const generate = generateModule.default;

// twgl 4.4.0's npm package only ships a webpack bundle. Its 15 modules have
// an acyclic static graph; the webpack cache/factories add no required ordering.
// Fail closed when upstream changes instead of guessing another bundle format.
export function unbundleTWGL(code) {
  if (createHash('sha256').update(code).digest('hex') !==
      '60a924fb69acaba30567e9bd349890aa27b74664e4015c44634838c016191e8c') {
    throw new Error('TWGL source changed; review its module graph before updating the source pack');
  }
  let functions;
  traverse(parse(code), {CallExpression(p) {
    const array = p.node.arguments[0];
    if (t.isArrayExpression(array) && array.elements.length === 15 &&
        array.elements.every(item => t.isFunctionExpression(item))) functions = array.elements;
  }});
  if (!functions) throw new Error('Missing audited TWGL module table');
  return functions.map(fn => {
    const tree = t.file(t.program(fn.body.body));
    traverse(tree, {CallExpression(p) {
      if (!t.isIdentifier(p.node.callee, {name: '__webpack_require__'})) return;
      const [id] = p.node.arguments;
      if (p.node.arguments.length !== 1 || !t.isNumericLiteral(id) || id.value < 0 || id.value >= 15) {
        throw new Error('Non-static TWGL dependency');
      }
      p.replaceWith(t.callExpression(t.identifier('require'), [t.stringLiteral(`\0specialized-twgl:${id.value}.js`)]));
    }});
    const result = generate(tree, {comments: false}).code;
    if (result.includes('__webpack_require__')) throw new Error('Unconverted TWGL bootstrap reference');
    return result;
  });
}
