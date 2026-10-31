'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('pdfmini', {
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    forceClose: () => invoke('window:forceClose'),
    isMaximized: () => invoke('window:isMaximized'),
    onState: (cb) => ipcRenderer.on('window:state', (e, s) => cb(s)),
    onCloseRequest: (cb) => ipcRenderer.on('window:close-request', () => cb())
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  recent: {
    list: () => invoke('recent:list'),
    add: (info) => invoke('recent:add', info),
    clear: () => invoke('recent:clear')
  },
  file: {
    pick: (opts) => invoke('file:pick', opts),
    read: (p) => invoke('file:read', p),
    exists: (p) => invoke('file:exists', p),
    save: (opts) => invoke('file:save', opts),
    writeInPlace: (opts) => invoke('file:writeInPlace', opts),
    saveImage: (opts) => invoke('file:saveImage', opts),
    saveText: (opts) => invoke('file:saveText', opts)
  },
  font: {
    systemCJK: (opt) => invoke('font:systemCJK', opt || {})
  },
  clipboard: {
    writeImage: (dataUrl) => invoke('clipboard:writeImage', { dataUrl }),
    writeText: (text) => invoke('clipboard:writeText', text),
    read: () => invoke('clipboard:read')
  },
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url),
    reveal: (p) => invoke('shell:reveal', p)
  },
  onOpenPath: (cb) => ipcRenderer.on('file:openPath', (e, p) => cb(p))
});
