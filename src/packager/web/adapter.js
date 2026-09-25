import assetCache from './cache';
import request from '../../common/request';
import {readAsURL, readAsArrayBuffer} from '../../common/readers';
import defaultIcon from '../images/default-icon.png';

class WebAdapter {
  linkSpecialized (options) {
    return new Promise((resolve, reject) => {
      const urls = [];
      let workerURL = new URL('specialized-worker.js', document.baseURI);
      if (window.__ASSETS__ && window.__ASSETS__['specialized-worker.js']) {
        const assets = window.__ASSETS__;
        workerURL = URL.createObjectURL(new Blob([
          `self.__specializedWasmBytes = Uint8Array.from(atob(${JSON.stringify(assets['bindings_wasm_bg.wasm'])}), c => c.charCodeAt(0));\n`,
          assets['rollup.browser.js'], '\n', assets['specialized-worker.js']
        ], {type: 'text/javascript'}));
        urls.push(workerURL);
      }
      const worker = new Worker(workerURL);
      const cleanup = () => { worker.terminate(); urls.forEach(url => URL.revokeObjectURL(url)); };
      worker.onmessage = ({data}) => {
        cleanup();
        if (data.error) reject(Object.assign(new Error(data.error), {missingDependency: data.missingDependency})); else resolve(data.result);
      };
      worker.onerror = event => { cleanup(); reject(new Error(event.message)); };
      worker.postMessage(options);
    });
  }
  prepareExtension (options) { return this.linkSpecialized({operation: 'extension', options}); }
  inspectExtension (code) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([code], {type: 'text/javascript'}));
      const worker = new Worker(url);
      const cleanup = () => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Extension metadata collection timed out')); }, 5000);
      worker.onmessage = ({data}) => {
        if (data.type !== 'ready') return;
        cleanup();
        if (!data.infos.length) reject(new Error('Extension must register during initialization')); else resolve(data.infos);
      };
      worker.onerror = event => { cleanup(); reject(new Error(event.message)); };
    });
  }
  getCachedAsset (asset) {
    return assetCache.get(asset)
  }

  async cacheAsset (asset, result) {
    await assetCache.set(asset, result);
  }

  getAppIcon (file) {
    if (!file) {
      return request({
        url: defaultIcon,
        type: 'arraybuffer'
      });
    }
    // Convert to PNG
    if (file.type === 'image/png') {
      return readAsArrayBuffer(file);
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        image.onload = null;
        image.onerror = null;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Cannot get rendering context for icon conversion'));
          return;
        }
        canvas.width = image.width;
        canvas.height = image.height;
        ctx.drawImage(image, 0, 0);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          resolve(readAsArrayBuffer(blob));
        });
      };
      image.onerror = () => {
        image.onload = null;
        image.onerror = null;
        reject(new Error('Cannot load icon'));
      };
      image.src = url;
    });
  }

  readAsURL (file, debugInfo) {
    return readAsURL(file)
      .catch((err) => {
        throw new Error(`${debugInfo}: ${err}`);
      });
  }

  fetchExtensionScript (url) {
    return request({
      type: 'text',
      url: url
    });
  }
}

export default WebAdapter;
