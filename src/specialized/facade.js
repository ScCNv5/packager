// Parsed into the joint link input at build time, never evaluated as runtime text.
export const facadeSource = String.raw`let playerLoaded, playerError; (() => {
  const listeners = new Map();
  const types = new Set(['loaded', 'state', 'problem', 'error']);
  let disposed = false;
  let loaded = false;
  const emit = (type, data) => {
    const event = Object.freeze({type, ...data});
    for (const listener of [...(listeners.get(type) || [])]) {
      try { listener(event); } catch (error) { console.error(error); }
    }
  };
  const guard = () => { if (disposed) throw new Error('Player disposed'); };
  const start = () => { guard(); if (!loaded) throw new Error('Player is loading'); scaffolding.start(); };
  const stop = () => { guard(); vm.stopAll(); };
  const pause = () => { guard(); vm.setPaused(true); emit('state', {state: 'paused'}); };
  const resume = () => { guard(); vm.setPaused(false); emit('state', {state: 'running'}); };
  const on = (type, listener) => {
    guard();
    if (!types.has(type) || typeof listener !== 'function') throw new TypeError('Invalid player listener');
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
  };
  const off = (type, listener) => { if (listeners.has(type)) listeners.get(type).delete(listener); };
  const postInput = (device, data) => {
    guard();
    const fields = {keyboard: ['key', 'keyCode', 'isDown'], mouse: ['x', 'y', 'canvasWidth', 'canvasHeight', 'isDown', 'button'],
      mouseWheel: ['deltaX', 'deltaY'], userData: ['username']};
    if (!Object.prototype.hasOwnProperty.call(fields, device) || !data || typeof data !== 'object') throw new TypeError('Invalid input device');
    const copy = {};
    for (const key of fields[device]) {
      const value = data[key];
      if (['string', 'number', 'boolean'].includes(typeof value)) copy[key] = value;
    }
    vm.postIOData(device, copy);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; vm.runtime.__spDisposed = true; vm.stopAll(); vm.quit(); vm.clear();
    for (const worker of vm.runtime.__spWorkers || []) worker.close();
    if (vm.runtime.audioEngine && vm.runtime.audioEngine.audioContext) vm.runtime.audioEngine.audioContext.close();
    scaffolding._specializedDispose();
    emit('state', {state: 'disposed'}); listeners.clear();
  };
  vm.runtime.on('PROJECT_RUN_START', () => emit('state', {state: 'running'}));
  vm.runtime.on('PROJECT_RUN_STOP', () => emit('state', {state: vm.isPaused() ? 'paused' : 'stopped'}));
  window.player = Object.freeze({start, stop, pause, resume, postInput, on, off, dispose});
  playerLoaded = () => { if (disposed) return; loaded = true; emit('loaded', {}); };
  playerError = error => { if (disposed) return; console.error(error); emit('error', {message: String(error && error.message || error)}); };
})();`;
