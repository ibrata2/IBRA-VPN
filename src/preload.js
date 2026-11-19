'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);
const on = (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d));

contextBridge.exposeInMainWorld('vpn', {
  init: () => invoke('init'),
  win: a => invoke('win', a),
  connect: () => invoke('connect'),
  disconnect: () => invoke('disconnect'),
  toggle: () => invoke('toggle'),
  adminRelaunch: () => invoke('admin-relaunch'),
  checkIp: () => invoke('check-ip'),
  select: o => invoke('select', o),
  add: t => invoke('add', t),
  clipboard: () => invoke('clipboard'),
  copy: t => invoke('copy', t),
  remove: ids => invoke('remove', ids),
  rename: o => invoke('rename', o),
  removeDead: () => invoke('remove-dead'),
  sort: () => invoke('sort'),
  best: () => invoke('best'),
  test: ids => invoke('test', ids),
  fetchFree: () => invoke('fetch-free'),
  removeFree: () => invoke('remove-free'),
  subUpdate: id => invoke('sub-update', id),
  subRemove: id => invoke('sub-remove', id),
  openTelegram: id => invoke('open-telegram', id),
  share: id => invoke('share', id),
  warpReset: () => invoke('warp-reset'),
  warpEndpoint: ep => invoke('warp-endpoint', ep),
  settings: p => invoke('settings', p),
  open: u => invoke('open', u),
  openLogs: () => invoke('open-logs'),
  browsers: () => invoke('browsers'),
  installExtension: id => invoke('install-extension', id),
  checkUpdate: () => invoke('check-update'),
  installUpdate: () => invoke('install-update'),
  on
});
