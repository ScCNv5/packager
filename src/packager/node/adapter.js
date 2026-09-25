import fs from 'fs';
import path from 'path';
import {promisify} from 'util';
import fetch from 'cross-fetch';
import {name} from '../../../package.json';
import defaultIcon from '../images/default-icon.png';
import Image from './image';
import {linkSpecialized, prepareExtension, inspectExtension} from 'specialized-link';
import {PNG} from 'pngjs';
import {Icns, IcnsImage} from '@fiahfy/icns';
import {DOMParser, DOMImplementation, XMLSerializer} from '@xmldom/xmldom';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);

const safeJoin = (root, file) => {
  root = path.join(root, '/');
  const joined = path.join(root, file);
  if (joined.startsWith(root)) {
    return joined;
  }
  return null;
};

const cacheDirectory = path.join(__dirname, '..', '.packager-cache');
const getCachePath = async (asset) => {
  if (!asset.sha256) return null;
  const path = safeJoin(cacheDirectory, asset.sha256);
  if (path) {
    await mkdir(cacheDirectory, {
      recursive: true
    });
    return path;
  }
  return null;
};

const nodeBufferToArrayBuffer = (buffer) => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
const arrayBufferToNodeBuffer = (buffer) => Buffer.from(buffer);

class NodeAdapter {
  parseXML (text) { return new DOMParser().parseFromString(text, 'text/xml'); }
  createXMLDocument (name) { return new DOMImplementation().createDocument(null, name); }
  serializeXML (document) { return new XMLSerializer().serializeToString(document); }
  async pngToAppleICNS (bytes) {
    const source = PNG.sync.read(Buffer.from(bytes));
    const icon = new Icns();
    const formats = [['ic04', 16], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
      ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
    for (const [type, size] of formats) {
      if (size !== 16 && (source.width < size || source.height < size)) continue;
      const output = new PNG({width: size, height: size});
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const x0 = Math.floor(x * source.width / size), x1 = Math.max(x0 + 1, Math.floor((x + 1) * source.width / size));
        const y0 = Math.floor(y * source.height / size), y1 = Math.max(y0 + 1, Math.floor((y + 1) * source.height / size));
        const sums = [0, 0, 0]; let alpha = 0, count = 0;
        for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
          const offset = (sy * source.width + sx) * 4, a = source.data[offset + 3];
          for (let channel = 0; channel < 3; channel++) sums[channel] += source.data[offset + channel] * a;
          alpha += a; count++;
        }
        const offset = (y * size + x) * 4;
        for (let channel = 0; channel < 3; channel++) output.data[offset + channel] = alpha ? Math.round(sums[channel] / alpha) : 0;
        output.data[offset + 3] = Math.round(alpha / count);
      }
      icon.append(await IcnsImage.fromPNG(PNG.sync.write(output), type));
    }
    return icon.data;
  }
  linkSpecialized (options) { return linkSpecialized(options); }
  prepareExtension (options) { return prepareExtension(options); }
  inspectExtension (code) { return inspectExtension(code); }
  async getCachedAsset (asset) {
    const urls = asset.src;
    const src = Array.isArray(urls) ? urls[0] : urls;

    if (src.startsWith('https:')) {
      const cachePath = await getCachePath(asset);
      if (cachePath) {
        try {
          return nodeBufferToArrayBuffer(await readFile(cachePath));
        } catch (e) {
          // ignore
        }
      }
      console.log(`[${name}]: downloading large asset ${src}; this may take a while`);
      const res = await fetch(src);
      if (!res.ok) {
        throw new Error(`Unexpected status code: ${res.status}`);
      }
      const arrayBuffer = await res.arrayBuffer();
      if (cachePath) {
        await writeFile(cachePath, arrayBufferToNodeBuffer(arrayBuffer));
      }
      return arrayBuffer;
    }
  }

  async cacheAsset (asset, result) {
    // all of our caching logic lives in getCachedAsset
  }

  async getAppIcon (file) {
    if (!file) {
      // Use the default icon when no icon is given
      const buffer = await readFile(path.join(__dirname, defaultIcon));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    if (file instanceof Image) {
      if (file.mimeType === 'image/png') {
        return file.readAsBuffer();
      }
      throw new Error('icon must be of type image/png but found ' + file.mimeType + ' instead.');
    }
    throw new Error('file must be an instance of Packager.Image or null but found ' + file + ' instead.');
  }

  readAsURL (file) {
    if (!(file instanceof Image)) {
      throw new Error('file must be an instance of Packager.Image but found ' + file + ' instead.');
    }
    return file.readAsURL();
  }

  fetchExtensionScript (url) {
    return fetch(url)
      .then(res => {
        if (res.ok) {
          return res.text();
        }
        throw new Error(`Unexpected status code: ${res.status}`);
      });
  }
}

export default NodeAdapter;
