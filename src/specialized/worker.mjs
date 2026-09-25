import sourcePack from '../../generated/runtime-sources.json';
import {linkPlayer} from './link.mjs';
import {prepareExtension} from './extensions.mjs';
// Shipped beside the worker, including its pinned WASM parser. No CDN resolution.
if (!self.rollup) importScripts('./rollup.browser.js');
self.onmessage = async ({data}) => {
  try { self.postMessage({result: data.operation === 'extension' ?
    await prepareExtension(data.options, sourcePack, self.rollup.rollup) :
    await linkPlayer({...data, sourcePack}, self.rollup.rollup)}); }
  catch (error) { self.postMessage({error: String(error && error.stack || error), missingDependency: error.missingDependency}); }
};
