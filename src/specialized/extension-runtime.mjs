export const extensionLoaderBody = extensions => `{
  if (this.runtime.__spDisposed) throw new Error('Player disposed');
  if (this.isBuiltinExtension(url)) { this.loadExtensionIdSync(url); return; }
  const fixed = ${JSON.stringify(extensions.map(({token, infos, code}) => ({token, infos, code})))}.find(entry => entry.token === url);
  if (!fixed) throw new Error('Only extensions frozen into this player can be loaded');
  if (fixed.infos.every(info => this.isExtensionLoaded(info.id))) return;
  const objectURL = URL.createObjectURL(new Blob([fixed.code], {type: 'text/javascript'}));
  const worker = new Worker(objectURL);
  const pending = new Map();
  let sequence = 0;
  const lifetime = {close: () => {
    worker.terminate(); URL.revokeObjectURL(objectURL);
    for (const promise of pending.values()) promise.reject(new Error('Extension worker disposed'));
    pending.clear();
  }};
  (this.runtime.__spWorkers || (this.runtime.__spWorkers = [])).push(lifetime);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { lifetime.close(); reject(new Error('Fixed extension startup timed out')); }, 10000);
    worker.onerror = event => { clearTimeout(timeout); lifetime.close(); reject(new Error(event.message)); };
    worker.onmessage = ({data}) => {
      if (data.type === 'result') {
        const promise = pending.get(data.id);
        if (promise) { pending.delete(data.id); if (data.error) promise.reject(new Error(data.error)); else promise.resolve(data.value); }
        return;
      }
      if (data.type !== 'ready') return;
      clearTimeout(timeout); URL.revokeObjectURL(objectURL);
      if (JSON.stringify(data.infos) !== JSON.stringify(fixed.infos)) {
        lifetime.close(); reject(new Error('Fixed extension metadata changed since build')); return;
      }
      try {
        fixed.infos.forEach((info, index) => {
          const proxy = {getInfo: () => JSON.parse(JSON.stringify(info))};
          for (const block of info.blocks || []) if (block && typeof block === 'object' && block.opcode) {
            const method = block.func || block.opcode;
            proxy[method] = args => new Promise((resolve, reject) => {
              const id = sequence++;
              pending.set(id, {resolve, reject});
              worker.postMessage({type: 'call', id, extension: index, method, args});
            });
          }
          const service = this._registerInternalExtension(proxy);
          this._loadedExtensions.set(info.id, service);
        });
        resolve();
      } catch (error) { lifetime.close(); reject(error); }
    };
  });
}`;
