'use strict';
// IBRA VPN — main process. برمجة وتطوير ابراهيم الخزرجي

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, clipboard, net, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const tcp = require('net');
const { spawn, execFile } = require('child_process');

const { parseLink, parseMany, isSubscriptionUrl } = require('./core/links');
const { buildConfig, buildMultiTestConfig } = require('./core/config');
const warp = require('./core/warp');
const sysproxy = require('./core/sysproxy');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch {}

const APP_ID = 'com.ibraprogram.ibravpn';
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const DATA = app.getPath('userData');
const STORE_FILE = path.join(DATA, 'ibra-vpn.json');
const RUN_DIR = path.join(DATA, 'run');
fs.mkdirSync(RUN_DIR, { recursive: true });

// ---------------- store ----------------
const DEFAULTS = {
  servers: [],
  subscriptions: [],           // {id,name,url,updatedAt,count}
  selected: null,              // server id, 'warp'
  engine: 'server',            // server | warp | bypass
  warpAccount: null,
  warpEndpoint: { host: warp.WARP_ENDPOINTS[0], port: 2408 },
  settings: {
    lang: 'ar', theme: 'gold', mode: 'proxy', routing: 'global', blockAds: false, dns: 'cloudflare',
    mixedPort: 20808, apiPort: 20809, autoStart: false, autoConnect: false, startHidden: false,
    closeToTray: true, autoUpdate: true
  },
  lastProxyPort: null
};

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return Object.assign({}, DEFAULTS, j, { settings: Object.assign({}, DEFAULTS.settings, j.settings || {}) });
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
let store = loadStore();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STORE_FILE + '.tmp', JSON.stringify(store, null, 1)); fs.renameSync(STORE_FILE + '.tmp', STORE_FILE); } catch (e) { log('store save failed: ' + e.message); }
  }, 150);
}
function saveNow() { clearTimeout(saveTimer); try { fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 1)); } catch {} }

// ---------------- logging ----------------
const logLines = [];
function log(line) {
  const l = `[${new Date().toLocaleTimeString('en-GB')}] ${String(line).trim()}`;
  for (const part of l.split(/\r?\n/)) { if (part.trim()) logLines.push(part); }
  while (logLines.length > 600) logLines.shift();
  send('log', l);
}

// ---------------- window / tray ----------------
let win = null, tray = null, quitting = false;
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function createWindow(show = true) {
  win = new BrowserWindow({
    width: 430, height: 760, minWidth: 400, minHeight: 640,
    frame: false, transparent: false, resizable: true, show: false,
    backgroundColor: '#0b0b0d', icon: ICON, title: 'IBRA VPN',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', e => {
    if (!quitting && store.settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
}

function trayMenu() {
  const ar = store.settings.lang === 'ar';
  const connected = state.status === 'connected';
  return Menu.buildFromTemplate([
    { label: 'IBRA VPN', enabled: false },
    { type: 'separator' },
    { label: connected ? (ar ? 'قطع الاتصال' : 'Disconnect') : (ar ? 'اتصال' : 'Connect'), click: () => (connected ? disconnect() : connect()) },
    { label: ar ? 'فتح النافذة' : 'Open', click: showWindow },
    { type: 'separator' },
    { label: ar ? 'خروج' : 'Quit', click: () => { quitting = true; app.quit(); } }
  ]);
}
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`IBRA VPN — ${state.status === 'connected' ? (store.settings.lang === 'ar' ? 'متصل' : 'Connected') : (store.settings.lang === 'ar' ? 'غير متصل' : 'Disconnected')}`);
  tray.setContextMenu(trayMenu());
}
function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  refreshTray();
}
function showWindow() { if (!win || win.isDestroyed()) createWindow(); win.show(); win.focus(); }

app.on('second-instance', showWindow);

// ---------------- core process ----------------
function corePath() {
  const exe = process.platform === 'win32' ? 'sing-box.exe' : 'sing-box';
  const candidates = [
    path.join(process.resourcesPath || '', 'core', exe),
    path.join(__dirname, '..', 'core', exe)
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[1];
}

const state = { status: 'disconnected', since: null, server: null, ip: null, error: null, up: 0, down: 0, upTotal: 0, downTotal: 0 };
let core = null, trafficReq = null, stopping = false;

function pushState() { send('state', state); refreshTray(); }

function isAdmin() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(true);
    execFile('net', ['session'], { windowsHide: true }, err => resolve(!err));
  });
}

function relaunchAsAdmin() {
  const exe = process.execPath;
  const args = process.defaultApp ? `'${path.resolve(process.argv[1])}', '--connect'` : `'--connect'`;
  execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -ArgumentList ${args} -Verb RunAs`], { windowsHide: true }, err => {
    if (!err) { quitting = true; cleanupSync(); app.exit(0); }
  });
}

function portFree(port) {
  return new Promise(resolve => {
    const s = tcp.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function freePort(start) {
  for (let p = start; p < start + 200; p++) if (await portFree(p)) return p;
  throw new Error('no free port');
}

function currentServer() {
  if (store.engine === 'warp') return store.warpAccount ? warp.toServer(store.warpAccount, store.warpEndpoint) : null;
  if (store.engine === 'bypass') return { id: 'bypass', name: 'BYPASS', protocol: 'bypass' };
  return store.servers.find(s => s.id === store.selected) || store.servers[0] || null;
}

function waitApi(port, ms = 8000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/version', timeout: 800 }, res => { res.resume(); resolve(); });
      req.on('error', () => (Date.now() - t0 > ms ? reject(new Error('core did not start')) : setTimeout(tryOnce, 200)));
      req.on('timeout', () => req.destroy());
    };
    tryOnce();
  });
}

async function connect() {
  if (state.status === 'connected' || state.status === 'connecting') return;
  const s = store.settings;
  state.error = null;
  try {
    if (store.engine === 'warp' && !store.warpAccount) {
      state.status = 'connecting'; pushState();
      log('WARP: registering free account…');
      store.warpAccount = await warp.register(); save();
      log('WARP: account ready');
    }
    const server = currentServer();
    if (!server) throw new Error('NO_SERVER');
    if (server.protocol === 'mtproto') throw new Error('MTPROTO_ONLY_TELEGRAM');
    if (s.mode === 'tun' && !(await isAdmin())) throw new Error('NEED_ADMIN');
    if (!fs.existsSync(corePath())) throw new Error('CORE_MISSING');

    state.status = 'connecting'; state.server = { id: server.id, name: server.name, protocol: server.protocol }; pushState();

    const mixedPort = await freePort(s.mixedPort);
    const apiPort = await freePort(s.apiPort === mixedPort ? s.apiPort + 1 : s.apiPort);
    const cfg = buildConfig({
      engine: store.engine === 'bypass' ? 'bypass' : 'server', server: store.engine === 'bypass' ? null : server,
      mode: s.mode, routing: s.routing, blockAds: s.blockAds, dns: s.dns, mixedPort, apiPort, cacheDir: RUN_DIR, logLevel: 'info'
    });
    const cfgFile = path.join(RUN_DIR, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1));
    log(`connecting → ${server.name} [${server.protocol}] mode=${s.mode} routing=${s.routing}`);

    stopping = false;
    core = spawn(corePath(), ['run', '-c', cfgFile, '-D', RUN_DIR, '--disable-color'], { windowsHide: true, cwd: path.dirname(corePath()) });
    core.stdout.on('data', d => log(d.toString()));
    core.stderr.on('data', d => log(d.toString()));
    core.on('exit', code => {
      const unexpected = !stopping;
      core = null;
      stopTraffic();
      if (unexpected) {
        log(`core exited (${code})`);
        if (state.mixedPort) sysproxy.disable(state.mixedPort).catch(() => {});
        Object.assign(state, { status: 'disconnected', since: null, ip: null, up: 0, down: 0, mixedPort: null, error: state.status === 'connecting' ? 'CORE_FAILED' : 'CORE_STOPPED' });
        pushState();
        notify(store.settings.lang === 'ar' ? 'انقطع الاتصال' : 'Connection lost');
      }
    });

    await waitApi(apiPort);
    state.mixedPort = mixedPort; state.apiPort = apiPort;
    if (s.mode === 'proxy') {
      await sysproxy.enable(mixedPort);
      store.lastProxyPort = mixedPort; save();
    }
    Object.assign(state, { status: 'connected', since: Date.now(), up: 0, down: 0, upTotal: 0, downTotal: 0 });
    pushState();
    startTraffic(apiPort);
    checkIp();
    log('connected ✓');
  } catch (e) {
    log('connect failed: ' + e.message);
    await killCore();
    Object.assign(state, { status: 'disconnected', since: null, error: e.message });
    pushState();
  }
}

function killCore() {
  return new Promise(resolve => {
    if (!core) return resolve();
    stopping = true;
    const pid = core.pid;
    const done = () => resolve();
    core.once('exit', done);
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else core.kill('SIGTERM');
    setTimeout(done, 3000);
  });
}

async function disconnect() {
  if (state.status === 'disconnected') return;
  state.status = 'disconnecting'; pushState();
  stopTraffic();
  try { await sysproxy.disable(state.mixedPort); } catch (e) { log('proxy off failed: ' + e.message); }
  store.lastProxyPort = null; save();
  await killCore();
  Object.assign(state, { status: 'disconnected', since: null, ip: null, up: 0, down: 0, error: null, mixedPort: null });
  pushState();
  log('disconnected');
}

function cleanupSync() {
  stopTraffic();
  if (core) {
    stopping = true;
    try { if (process.platform === 'win32') require('child_process').execFileSync('taskkill', ['/PID', String(core.pid), '/T', '/F'], { windowsHide: true }); else core.kill(); } catch {}
  }
  if (state.mixedPort && store.settings.mode === 'proxy' && process.platform === 'win32') {
    try {
      require('child_process').execFileSync('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true });
    } catch {}
  }
  store.lastProxyPort = null; saveNow();
}

function startTraffic(apiPort) {
  stopTraffic();
  trafficReq = http.get({ host: '127.0.0.1', port: apiPort, path: '/traffic' }, res => {
    let buf = '';
    res.on('data', c => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const t = JSON.parse(line);
          state.up = t.up || 0; state.down = t.down || 0;
          state.upTotal += state.up; state.downTotal += state.down;
          send('traffic', { up: state.up, down: state.down, upTotal: state.upTotal, downTotal: state.downTotal });
        } catch {}
      }
    });
  });
  trafficReq.on('error', () => {});
}
function stopTraffic() { if (trafficReq) { try { trafficReq.destroy(); } catch {} trafficReq = null; } }

// public IP / country through the tunnel
async function checkIp() {
  if (state.status !== 'connected') return;
  try {
    const ses = session.fromPartition('ibra-ipcheck');
    await ses.setProxy({ proxyRules: `socks5://127.0.0.1:${state.mixedPort}` });
    const j = await fetchJson('https://ipwho.is/?fields=ip,country,country_code,city,flag', ses, 10000);
    state.ip = { ip: j.ip, country: j.country, code: j.country_code, city: j.city, flag: j.flag && j.flag.emoji };
  } catch (e) {
    log('IP check: ' + e.message);
    state.ip = { failed: true };
  }
  pushState();
}

function fetchJson(url, ses, timeout = 15000) {
  return fetchText(url, ses, timeout).then(t => JSON.parse(t));
}
function fetchText(url, ses, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, session: ses || session.defaultSession, useSessionCookies: false });
    req.setHeader('User-Agent', 'IBRA-VPN/' + app.getVersion() + ' v2rayN/7.0');
    const t = setTimeout(() => { req.abort(); reject(new Error('timeout')); }, timeout);
    req.on('response', res => {
      let buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        clearTimeout(t);
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode));
        resolve(Buffer.concat(buf).toString('utf8'));
      });
    });
    req.on('error', e => { clearTimeout(t); reject(e); });
    req.end();
  });
}

function notify(body) {
  try { if (Notification.isSupported()) new Notification({ title: 'IBRA VPN', body, icon: ICON }).show(); } catch {}
}

// ---------------- latency test ----------------
let testing = false;
async function testServers(ids) {
  if (testing) return;
  testing = true;
  const list = (ids && ids.length ? store.servers.filter(s => ids.includes(s.id)) : store.servers).filter(s => s.protocol !== 'mtproto');
  if (store.engine === 'warp' && store.warpAccount && (!ids || ids.includes('warp'))) list.push(warp.toServer(store.warpAccount, store.warpEndpoint));
  if (!list.length) { testing = false; return; }
  for (const s of list) send('ping', { id: s.id, ms: -2 }); // testing…
  let proc = null;
  try {
    const apiPort = await freePort(21900);
    const cfgFile = path.join(RUN_DIR, 'test.json');
    fs.writeFileSync(cfgFile, JSON.stringify(buildMultiTestConfig(list, apiPort)));
    proc = spawn(corePath(), ['run', '-c', cfgFile, '-D', RUN_DIR, '--disable-color'], { windowsHide: true });
    proc.on('error', e => log('test core: ' + e.message));
    await waitApi(apiPort);
    const queue = list.map((s, i) => ({ s, tag: 't' + i }));
    const worker = async () => {
      while (queue.length) {
        const { s, tag } = queue.shift();
        const ms = await delay(apiPort, tag);
        s.ping = ms;
        const stored = store.servers.find(x => x.id === s.id);
        if (stored) stored.ping = ms;
        send('ping', { id: s.id, ms });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    save();
  } catch (e) {
    log('test failed: ' + e.message);
    for (const s of list) send('ping', { id: s.id, ms: -1 });
  } finally {
    if (proc) { try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {}); else proc.kill(); } catch {} }
    testing = false;
  }
}

function delay(apiPort, tag) {
  return new Promise(resolve => {
    const p = `/proxies/${tag}/delay?timeout=6000&url=${encodeURIComponent('https://www.gstatic.com/generate_204')}`;
    const req = http.get({ host: '127.0.0.1', port: apiPort, path: p, timeout: 9000 }, res => {
      let b = '';
      res.on('data', c => (b += c));
      res.on('end', () => { try { const j = JSON.parse(b); resolve(j.delay > 0 ? j.delay : -1); } catch { resolve(-1); } });
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
  });
}

// ---------------- subscriptions ----------------
async function fetchSubscription(url) {
  // through the tunnel if connected (sub hosts are often blocked), else direct
  let ses = session.defaultSession;
  if (state.status === 'connected') {
    ses = session.fromPartition('ibra-sub');
    await ses.setProxy({ proxyRules: `socks5://127.0.0.1:${state.mixedPort}` });
  }
  return fetchText(url, ses, 25000);
}

async function updateSubscription(sub) {
  const text = await fetchSubscription(sub.url);
  const { servers, errors } = parseMany(text);
  const oldSel = store.servers.find(s => s.id === store.selected);
  store.servers = store.servers.filter(s => s.subId !== sub.id);
  servers.forEach(s => { s.subId = sub.id; });
  store.servers.push(...servers);
  if (oldSel && oldSel.subId === sub.id) {
    const same = servers.find(s => s.raw === oldSel.raw);
    store.selected = same ? same.id : (servers[0] && servers[0].id) || null;
  }
  sub.updatedAt = Date.now(); sub.count = servers.length;
  save();
  return { added: servers.length, errors: errors.length };
}

// ---------------- IPC ----------------
function publicStore() {
  return {
    servers: store.servers, subscriptions: store.subscriptions, selected: store.selected, engine: store.engine,
    warpReady: !!store.warpAccount, warpEndpoint: store.warpEndpoint, warpEndpoints: warp.WARP_ENDPOINTS, warpPorts: warp.WARP_PORTS,
    settings: store.settings, version: app.getVersion(), state, logs: logLines.slice(-300)
  };
}

ipcMain.handle('init', () => publicStore());

ipcMain.handle('win', (_e, act) => {
  if (!win) return;
  if (act === 'min') win.minimize();
  else if (act === 'close') win.close();
  else if (act === 'quit') { quitting = true; app.quit(); }
});

ipcMain.handle('connect', () => connect());
ipcMain.handle('disconnect', () => disconnect());
ipcMain.handle('toggle', () => (state.status === 'connected' ? disconnect() : connect()));
ipcMain.handle('admin-relaunch', () => relaunchAsAdmin());
ipcMain.handle('check-ip', () => checkIp());

ipcMain.handle('select', async (_e, { engine, id }) => {
  const wasOn = state.status === 'connected';
  if (engine) store.engine = engine;
  if (id) store.selected = id;
  save();
  if (wasOn) { await disconnect(); await connect(); }
  return publicStore();
});

ipcMain.handle('add', async (_e, text) => {
  text = String(text || '').trim();
  if (!text) throw new Error('EMPTY');
  if (isSubscriptionUrl(text)) {
    const sub = { id: 'sub' + Date.now().toString(36), name: new URL(text).hostname, url: text, updatedAt: 0, count: 0 };
    store.subscriptions.push(sub);
    try { const r = await updateSubscription(sub); return Object.assign({ sub: true }, r, { store: publicStore() }); }
    catch (e) { store.subscriptions = store.subscriptions.filter(x => x !== sub); save(); throw new Error('SUB_FAILED: ' + e.message); }
  }
  const { servers, errors } = parseMany(text);
  if (!servers.length) throw new Error('NO_VALID_LINKS' + (errors[0] ? ': ' + errors[0].error : ''));
  store.servers.push(...servers);
  if (!store.selected || !store.servers.find(s => s.id === store.selected)) store.selected = servers[0].id;
  if (store.engine !== 'server') { store.engine = 'server'; store.selected = servers[0].id; }
  save();
  return { added: servers.length, errors: errors.length, store: publicStore() };
});

ipcMain.handle('clipboard', () => clipboard.readText());
ipcMain.handle('copy', (_e, t) => clipboard.writeText(String(t || '')));

ipcMain.handle('remove', async (_e, ids) => {
  ids = [].concat(ids);
  if (state.status === 'connected' && state.server && ids.includes(state.server.id)) await disconnect();
  store.servers = store.servers.filter(s => !ids.includes(s.id));
  if (!store.servers.find(s => s.id === store.selected)) store.selected = store.servers[0] ? store.servers[0].id : null;
  save();
  return publicStore();
});

ipcMain.handle('rename', (_e, { id, name }) => {
  const s = store.servers.find(x => x.id === id);
  if (s && name) { s.name = String(name).slice(0, 80); save(); }
  return publicStore();
});

ipcMain.handle('remove-dead', () => {
  store.servers = store.servers.filter(s => !(s.ping === -1));
  if (!store.servers.find(s => s.id === store.selected)) store.selected = store.servers[0] ? store.servers[0].id : null;
  save();
  return publicStore();
});

ipcMain.handle('sort', () => {
  const v = s => (s.ping > 0 ? s.ping : 1e9);
  store.servers.sort((a, b) => v(a) - v(b));
  save();
  return publicStore();
});

ipcMain.handle('best', async () => {
  const best = store.servers.filter(s => s.ping > 0).sort((a, b) => a.ping - b.ping)[0];
  if (best) { store.selected = best.id; store.engine = 'server'; save(); }
  return publicStore();
});

ipcMain.handle('test', (_e, ids) => { testServers(ids); return true; });

ipcMain.handle('sub-update', async (_e, id) => {
  const subs = id ? store.subscriptions.filter(s => s.id === id) : store.subscriptions;
  let added = 0, failed = 0;
  for (const sub of subs) { try { added += (await updateSubscription(sub)).added; } catch (e) { failed++; log(`sub ${sub.name}: ${e.message}`); } }
  return { added, failed, store: publicStore() };
});

ipcMain.handle('sub-remove', (_e, id) => {
  store.subscriptions = store.subscriptions.filter(s => s.id !== id);
  store.servers = store.servers.filter(s => s.subId !== id);
  if (!store.servers.find(s => s.id === store.selected)) store.selected = store.servers[0] ? store.servers[0].id : null;
  save();
  return publicStore();
});

ipcMain.handle('open-telegram', (_e, id) => {
  const s = store.servers.find(x => x.id === id);
  if (s && s.tgLink) shell.openExternal(s.tgLink);
});

ipcMain.handle('share', (_e, id) => {
  const s = store.servers.find(x => x.id === id);
  if (s) clipboard.writeText(s.raw || '');
  return !!s;
});

ipcMain.handle('warp-reset', async () => {
  if (state.status === 'connected' && store.engine === 'warp') await disconnect();
  store.warpAccount = null; save();
  return publicStore();
});
ipcMain.handle('warp-endpoint', async (_e, ep) => {
  store.warpEndpoint = { host: ep.host || warp.WARP_ENDPOINTS[0], port: parseInt(ep.port, 10) || 2408 };
  save();
  if (state.status === 'connected' && store.engine === 'warp') { await disconnect(); await connect(); }
  return publicStore();
});

ipcMain.handle('settings', async (_e, patch) => {
  const before = Object.assign({}, store.settings);
  Object.assign(store.settings, patch || {});
  save();
  if ('autoStart' in (patch || {})) applyAutoStart();
  const needsReconnect = ['mode', 'routing', 'blockAds', 'dns'].some(k => k in (patch || {}) && before[k] !== store.settings[k]);
  if (needsReconnect && state.status === 'connected') { await disconnect(); await connect(); }
  refreshTray();
  return publicStore();
});

ipcMain.handle('open', (_e, url) => { if (/^(https?:|tg:)/.test(url)) shell.openExternal(url); });
ipcMain.handle('open-logs', () => shell.openPath(RUN_DIR));
ipcMain.handle('check-update', () => checkUpdates(true));
ipcMain.handle('install-update', () => { if (autoUpdater) { quitting = true; cleanupSync(); autoUpdater.quitAndInstall(false, true); } });

function applyAutoStart() {
  if (process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!store.settings.autoStart, args: ['--hidden'] });
}

// ---------------- updates ----------------
function checkUpdates(manual) {
  if (!autoUpdater || !app.isPackaged) { if (manual) send('update', { status: 'none' }); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdates().catch(e => { if (manual) send('update', { status: 'error', message: e.message }); });
}
if (autoUpdater) {
  autoUpdater.on('update-available', i => send('update', { status: 'downloading', version: i.version }));
  autoUpdater.on('update-not-available', () => send('update', { status: 'none' }));
  autoUpdater.on('download-progress', p => send('update', { status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => { send('update', { status: 'ready', version: i.version }); notify(store.settings.lang === 'ar' ? `تحديث جديد ${i.version} جاهز للتثبيت` : `Update ${i.version} ready`); });
  autoUpdater.on('error', e => log('update: ' + e.message));
}

// ---------------- lifecycle ----------------
app.whenReady().then(async () => {
  // a crash last time may have left our system proxy on
  if (store.lastProxyPort) { await sysproxy.disable(store.lastProxyPort).catch(() => {}); store.lastProxyPort = null; save(); }
  const hidden = process.argv.includes('--hidden') || store.settings.startHidden;
  createWindow(!hidden);
  createTray();
  applyAutoStart();
  if (store.settings.autoConnect || process.argv.includes('--connect')) setTimeout(connect, 800);
  if (store.settings.autoUpdate) setTimeout(() => checkUpdates(false), 5000);
});

app.on('before-quit', () => { quitting = true; cleanupSync(); });
app.on('window-all-closed', () => { if (process.platform !== 'win32' || !store.settings.closeToTray) app.quit(); });
process.on('exit', cleanupSync);
