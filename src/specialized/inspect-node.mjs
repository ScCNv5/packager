import {spawn} from 'node:child_process';

// Metadata collection runs in a short-lived, permission-restricted process. The
// context receives no host objects, filesystem, environment, VM, or compiler.
const inspector = String.raw`
const vm = require('node:vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 16000000) process.exit(2); });
process.stdin.on('end', () => {
  try {
    const context = vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}, microtaskMode: 'afterEvaluate'});
    vm.runInContext('var __messages = []; var self = {postMessage: value => __messages.push(value)}; var console = {log(){},warn(){},error(){}};', context);
    vm.runInContext(JSON.parse(input).code, context, {timeout: 3000});
    const messages = JSON.parse(vm.runInContext('JSON.stringify(__messages)', context, {timeout: 1000}));
    const ready = messages.find(message => message.type === 'ready');
    if (!ready || !ready.infos.length) throw new Error('Extension must register during initialization');
    process.stdout.write(JSON.stringify({infos: ready.infos}));
  } catch (error) { process.stdout.write(JSON.stringify({error: String(error)})); }
});`;

export function inspectExtension(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', '--disable-proto=throw', '--eval', inspector],
      {env: {}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', errors = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Extension metadata collection timed out')); }, 5000);
    child.stdout.on('data', value => { output += value; if (output.length > 1000000) child.kill(); });
    child.stderr.on('data', value => { if (errors.length < 10000) errors += value; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', status => {
      clearTimeout(timeout);
      try {
        if (status !== 0) throw new Error(`Extension inspector failed (${status}): ${errors}`);
        const result = JSON.parse(output);
        if (result.error) throw new Error(result.error);
        resolve(result.infos);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({code}));
  });
}
