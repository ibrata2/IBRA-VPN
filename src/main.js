'use strict';
// IBRA VPN — main process. برمجة وتطوير ابراهيم الخزرجي

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, clipboard, net, session, Notification, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const tcp = require('net');
const { spawn, execFile } = require('child_process');

const { parseLink, parseMany, isSubscriptionUrl } = require('./core/links');
const { buildConfig, buildMultiTestConfig } = require('./core/config');
const warp = require('./core/warp');
const sysproxy = require('./core/sysproxy');
const elevation = require('./core/elevation');
const bridge = require('./core/bridge');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch {}

const APP_ID = 'com.ibraprogram.ibravpn';
app.setAppUserModelId(APP_ID);

// An elevated copy started by the admin task may arrive while the normal copy is still closing — wait for it.
const ELEVATED_LAUNCH = process.argv.includes('--elevated') || process.argv.includes('--enable-admin');
let gotLock = app.requestSingleInstanceLock();
if (!gotLock && ELEVATED_LAUNCH) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 25 && !gotLock; i++) { Atomics.wait(sleeper, 0, 0, 250); gotLock = app.requestSingleInstanceLock(); }
}
if (!gotLock) { app.quit(); process.exit(0); }

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
    lang: 'ar', theme: 'red', mode: 'proxy', routing: 'global', blockAds: false, dns: 'cloudflare',
    mixedPort: 20808, apiPort: 20809, socialDirect: true, autoStart: false, autoConnect: false, startHidden: false,
    closeToTray: true, autoUpdate: true, alwaysAdmin: false
  },
  appliedInstallMode: null,
  lastProxyPort: null
};

function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return Object.assign({}, DEFAULTS, j, { settings: Object.assign({}, DEFAULTS.settings, j.settings || {}) });
  } catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}
let store = loadStore();

// Built-in free Telegram (MTProto) proxies — added once; the user can delete them.
const BUILTIN_TG = [
  'tg://proxy?server=fast.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b',
  'tg://proxy?server=Tond.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b'
];
store.seeded = store.seeded || [];
for (const l of BUILTIN_TG) {
  if (store.seeded.includes(l)) continue;
  try { const sv = parseLink(l); sv.builtin = true; store.servers.push(sv); store.seeded.push(l); } catch {}
}
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
    backgroundColor: '#0b0b0e', icon: ICON, title: 'IBRA VPN',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('maximize', () => send('maximized', true));
  win.on('unmaximize', () => send('maximized', false));
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

app.on('second-instance', (_e, argv) => { if (!handleProtocol(argv)) showWindow(); });

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
let gen = 0; // bumps on every disconnect so an in-flight connect() knows it was cancelled

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

// Arguments handed from the normal copy to the elevated copy (the admin task always starts it with --elevated only).
const PENDING_FILE = path.join(DATA, 'pending-launch.json');
function writePending(obj) { try { fs.writeFileSync(PENDING_FILE, JSON.stringify(Object.assign({ at: Date.now() }, obj))); } catch {} }
function readPending() {
  try {
    const j = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    fs.unlinkSync(PENDING_FILE);
    return Date.now() - (j.at || 0) < 60000 ? j : {};
  } catch { return {}; }
}

/** Restart elevated: silently through the admin task if it exists, otherwise with one UAC prompt. */
function elevateAndRestart(pending) {
  return new Promise(async resolve => {
    if (store.settings.alwaysAdmin) {
      writePending(pending);
      if (await elevation.runTask()) { quitting = true; cleanupSync(); app.exit(0); return resolve(true); }
    }
    const exe = process.execPath;
    const extra = pending.connect ? ", '--connect'" : '';
    const args = process.defaultApp ? `'${path.resolve(process.argv[1])}'${extra}` : `'--elevated'${extra}`;
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${exe}' -ArgumentList ${args} -Verb RunAs`], { windowsHide: true }, err => {
      if (err) return resolve(false); // UAC cancelled
      quitting = true; cleanupSync(); app.exit(0); resolve(true);
    });
  });
}

async function setAlwaysAdmin(on) {
  if (process.platform !== 'win32') return { ok: false };
  if (!on) {
    await elevation.removeTask();
    store.settings.alwaysAdmin = false; save();
    return { ok: true };
  }
  if (await isAdmin()) {
    const ok = await elevation.registerTask(process.execPath);
    store.settings.alwaysAdmin = ok; save();
    return { ok };
  }
  // one UAC approval: the elevated copy registers the task and stays open elevated
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath '${process.execPath}' -ArgumentList '--enable-admin' -Verb RunAs`], { windowsHide: true }, err => {
      if (err) return resolve({ ok: false, cancelled: true });
      quitting = true; cleanupSync(); app.exit(0); resolve({ ok: true });
    });
  });
}

// ibravpn://connect | disconnect | open — used by the browser extension to start the app
function handleProtocol(argv) {
  const url = (argv || []).find(a => /^ibravpn:\/\//i.test(a));
  if (!url) return false;
  const action = url.replace(/^ibravpn:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (action === 'connect') setTimeout(connect, 600);
  else if (action === 'disconnect') disconnect();
  else showWindow();
  return true;
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

function rulesDir() {
  const c = [path.join(process.resourcesPath || '', 'core', 'rules'), path.join(__dirname, '..', 'core', 'rules')];
  return c.find(p => fs.existsSync(p)) || null;
}

function currentServer() {
  if (store.engine === 'warp') return store.warpAccount ? warp.toServer(store.warpAccount, store.warpEndpoint) : null;
  if (store.engine === 'bypass') return { id: 'bypass', name: 'BYPASS', protocol: 'bypass' };
  return store.servers.find(s => s.id === store.selected && s.protocol !== 'mtproto') || store.servers.find(s => s.protocol !== 'mtproto') || null;
}

function waitApi(port, ms = 8000, watchCore = false) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/version', timeout: 800 }, res => { res.resume(); resolve(); });
      req.on('error', () => {
        if (watchCore && !core) return reject(new Error('CORE_FAILED'));
        Date.now() - t0 > ms ? reject(new Error('CORE_FAILED')) : setTimeout(tryOnce, 200);
      });
      req.on('timeout', () => req.destroy());
    };
    tryOnce();
  });
}

async function connect() {
  if (state.status !== 'disconnected') return;
  const my = ++gen;
  const cancelled = () => my !== gen;
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
    if (s.mode === 'tun' && !(await isAdmin())) {
      if (process.platform === 'win32' && app.isPackaged && await elevateAndRestart({ connect: true })) return;
      throw new Error('NEED_ADMIN');
    }
    if (!fs.existsSync(corePath())) throw new Error('CORE_MISSING');

    state.status = 'connecting'; state.server = { id: server.id, name: server.name, protocol: server.protocol }; pushState();

    const mixedPort = await freePort(s.mixedPort);
    const apiPort = await freePort(s.apiPort === mixedPort ? s.apiPort + 1 : s.apiPort);
    const cfg = buildConfig({
      engine: store.engine === 'bypass' ? 'bypass' : 'server', server: store.engine === 'bypass' ? null : server,
      mode: s.mode, routing: s.routing, blockAds: s.blockAds, dns: s.dns, socialDirect: s.socialDirect,
      rulesDir: rulesDir(), mixedPort, apiPort, cacheDir: RUN_DIR, logLevel: 'info'
    });
    if (cancelled()) return;
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
        Object.assign(state, { status: 'disconnected', since: null, ip: null, up: 0, down: 0, mixedPort: null, warning: null, error: state.status === 'connecting' ? 'CORE_FAILED' : 'CORE_STOPPED' });
        pushState();
        notify(store.settings.lang === 'ar' ? 'انقطع الاتصال' : 'Connection lost');
      }
    });

    await waitApi(apiPort, 10000, true);
    if (cancelled()) { await killCore(); return; }
    state.mixedPort = mixedPort; state.apiPort = apiPort;
    if (s.mode === 'proxy') {
      await sysproxy.enable(mixedPort);
      store.lastProxyPort = mixedPort; save();
    }
    Object.assign(state, { status: 'connected', since: Date.now(), up: 0, down: 0, upTotal: 0, downTotal: 0, warning: null });
    pushState();
    startTraffic(apiPort);
    healthCheck(apiPort);
    checkIp();
    log('connected ✓');
  } catch (e) {
    log('connect failed: ' + e.message);
    await killCore();
    if (cancelled()) return;
    Object.assign(state, { status: 'disconnected', since: null, error: e.message });
    pushState();
  }
}

// The core can start fine while the server itself is dead — test real traffic through it and warn the user.
async function healthCheck(apiPort) {
  const ms = await delay(apiPort, 'proxy');
  if (state.status !== 'connected' || state.apiPort !== apiPort) return;
  state.warning = ms < 0 ? 'SERVER_DEAD' : null;
  state.latency = ms > 0 ? ms : null;
  if (ms < 0) log('warning: server does not respond');
  pushState();
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
  if (state.status === 'disconnected' || state.status === 'disconnecting') return;
  gen++;
  state.status = 'disconnecting'; pushState();
  stopTraffic();
  try { await sysproxy.disable(state.mixedPort); } catch (e) { log('proxy off failed: ' + e.message); }
  store.lastProxyPort = null; save();
  await killCore();
  Object.assign(state, { status: 'disconnected', since: null, ip: null, up: 0, down: 0, error: null, mixedPort: null, warning: null, latency: null });
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

function coreCheck(cfgFile) {
  return new Promise(resolve => {
    execFile(corePath(), ['check', '-c', cfgFile], { windowsHide: true, timeout: 30000 }, (err, so, se) => resolve(err ? String(se || so || err.message) : null));
  });
}

// Tests many servers in one engine. Invalid entries (bad keys/methods from public lists) are dropped first,
// because one broken outbound stops the whole engine from starting. Returns Map(id -> ms, -1 = dead).
async function runTests(list, onResult, concurrency = 8) {
  const results = new Map();
  let items = list.map((s, i) => ({ s, tag: 't' + i }));
  const apiPort = await freePort(21900);
  const cfgFile = path.join(RUN_DIR, 'test.json');
  let cfg;
  for (let guard = 0; guard < 60 && items.length; guard++) {
    cfg = buildMultiTestConfig(items.map(x => x.s), apiPort);
    // buildMultiTestConfig tags by position; keep our tags aligned with it
    items.forEach((x, i) => { x.tag = 't' + i; });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const err = await coreCheck(cfgFile);
    if (!err) break;
    const m = /(outbound|endpoint)\[(\d+)\]/.exec(err);
    if (!m) { log('test config rejected: ' + err.trim().slice(0, 200)); return results; }
    const arr = m[1] === 'outbound' ? cfg.outbounds : (cfg.endpoints || []);
    const badTag = arr[parseInt(m[2], 10)] && arr[parseInt(m[2], 10)].tag;
    const bad = items.find(x => x.tag === badTag);
    if (!bad) { log('test config rejected: ' + err.trim().slice(0, 200)); return results; }
    results.set(bad.s.id, -1); if (onResult) onResult(bad.s, -1);
    items = items.filter(x => x !== bad);
  }
  if (!items.length) return results;
  const proc = spawn(corePath(), ['run', '-c', cfgFile, '-D', RUN_DIR, '--disable-color'], { windowsHide: true });
  proc.on('error', e => log('test core: ' + e.message));
  try {
    await waitApi(apiPort);
    const queue = items.slice();
    const worker = async () => {
      while (queue.length) {
        const { s, tag } = queue.shift();
        const first = await delayOnce(apiPort, tag, TEST_URLS[0]);
        const ms = first > 0 ? first : await delayOnce(apiPort, tag, TEST_URLS[1]);
        results.set(s.id, ms);
        if (onResult) onResult(s, ms);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {}); else proc.kill(); } catch {}
  }
  return results;
}

// TCP connect time — used for Telegram MTProto proxies (they can't be tested through the engine).
function tcpPing(host, port, timeout = 3500) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const sock = tcp.connect({ host: String(host).replace(/\.$/, ''), port });
    const done = ms => { sock.destroy(); resolve(ms); };
    sock.setTimeout(timeout, () => done(-1));
    sock.once('connect', () => done(Date.now() - t0));
    sock.once('error', () => done(-1));
  });
}

async function testServers(ids) {
  if (testing) return;
  testing = true;
  try {
    const sel = ids && ids.length ? store.servers.filter(s => ids.includes(s.id)) : store.servers;
    const list = sel.filter(s => s.protocol !== 'mtproto');
    const tg = sel.filter(s => s.protocol === 'mtproto');
    if (store.engine === 'warp' && store.warpAccount && (!ids || ids.includes('warp'))) list.push(warp.toServer(store.warpAccount, store.warpEndpoint));
    for (const s of list.concat(tg)) send('ping', { id: s.id, ms: -2 });
    const apply = (s, ms) => {
      const stored = store.servers.find(x => x.id === s.id);
      if (stored) stored.ping = ms;
      send('ping', { id: s.id, ms });
    };
    await Promise.all([
      list.length ? runTests(list, apply).catch(e => { log('test failed: ' + e.message); list.forEach(s => apply(s, -1)); }) : null,
      ...tg.map(s => tcpPing(s.outbound.server, s.outbound.server_port).then(ms => apply(s, ms)))
    ]);
    save();
  } finally { testing = false; }
}

// ---------------- free servers ----------------
const FREE_SOURCES = {
  v2ray: [
    'https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt',
    'https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/subscriptions/v2ray/super-sub.txt'
  ],
  mtproto: ['https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt']
};
const KEEP_VPN = 25, KEEP_TG = 12, SAMPLE_VPN = 160, SAMPLE_TG = 60;
let fetching = false;

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function progress(stage, extra) { send('fetch-progress', Object.assign({ stage }, extra || {})); }

async function fetchFreeServers() {
  if (fetching) return { busy: true };
  fetching = true;
  try {
    const sources = (store.settings.freeSources && store.settings.freeSources.length) ? store.settings.freeSources : null;
    const v2Urls = sources ? sources.filter(u => !/mtproto/i.test(u)) : FREE_SOURCES.v2ray;
    const tgUrls = sources ? sources.filter(u => /mtproto/i.test(u)) : FREE_SOURCES.mtproto;
    progress('download');
    const texts = await Promise.all(v2Urls.concat(tgUrls).map(u => fetchSubscription(u).catch(e => { log(`source ${u}: ${e.message}`); return ''; })));
    const have = new Set(store.servers.map(s => (s.outbound.server + ':' + s.outbound.server_port + ':' + s.protocol).toLowerCase()));
    const seen = new Set();
    const vpn = [], tg = [];
    for (const t of texts) {
      for (const s of parseMany(t).servers) {
        const key = (s.outbound.server + ':' + s.outbound.server_port + ':' + s.protocol).toLowerCase();
        if (have.has(key) || seen.has(key)) continue;
        seen.add(key);
        (s.protocol === 'mtproto' ? tg : vpn).push(s);
      }
    }
    if (!vpn.length && !tg.length) throw new Error('FETCH_FAILED');
    const vpnSample = shuffle(vpn).slice(0, SAMPLE_VPN);
    const tgSample = shuffle(tg).slice(0, SAMPLE_TG);
    const total = vpnSample.length + tgSample.length;
    let done = 0, alive = 0;
    const tick = ms => { done++; if (ms > 0) alive++; progress('test', { done, total, alive }); };
    progress('test', { done: 0, total, alive: 0 });

    const [vres, tres] = await Promise.all([
      vpnSample.length ? runTests(vpnSample, (s, ms) => tick(ms), 12) : new Map(),
      (async () => {
        const m = new Map(); const q = tgSample.slice();
        await Promise.all(Array.from({ length: 12 }, async () => { while (q.length) { const s = q.shift(); const ms = await tcpPing(s.outbound.server, s.outbound.server_port); m.set(s.id, ms); tick(ms); } }));
        return m;
      })()
    ]);

    const pick = (arr, res, n) => arr.map(s => Object.assign(s, { ping: res.get(s.id) })).filter(s => s.ping > 0).sort((a, b) => a.ping - b.ping).slice(0, n);
    const newVpn = pick(vpnSample, vres, KEEP_VPN);
    const newTg = pick(tgSample, tres, KEEP_TG);
    [...newVpn, ...newTg].forEach(s => { s.free = true; s.name = (s.protocol === 'mtproto' ? 'Telegram · ' : '⚡ ') + (s.name && s.name.length < 40 && !/^[A-Za-z0-9+/=]{30,}$/.test(s.name) ? s.name.replace(/^Telegram · /, '') : s.outbound.server); });

    // replace the previous batch of free servers that are no longer working
    const prevFree = store.servers.filter(s => s.free);
    const keepPrev = prevFree.filter(s => s.ping > 0 || (state.server && state.server.id === s.id));
    store.servers = store.servers.filter(s => !s.free).concat(keepPrev.slice(0, 10), newVpn, newTg);
    if (newVpn.length && (store.engine !== 'server' || !store.servers.find(s => s.id === store.selected && s.protocol !== 'mtproto'))) {
      if (state.status !== 'connected') { store.engine = 'server'; store.selected = newVpn[0].id; }
    }
    save();
    progress('done', { vpn: newVpn.length, tg: newTg.length });
    return { vpn: newVpn.length, tg: newTg.length, store: publicStore() };
  } catch (e) {
    progress('error', { message: e.message });
    throw e;
  } finally { fetching = false; }
}

const TEST_URLS = ['https://www.gstatic.com/generate_204', 'https://cp.cloudflare.com/generate_204', 'https://www.github.com/'];
async function delay(apiPort, tag) {
  for (const u of TEST_URLS) {
    const ms = await delayOnce(apiPort, tag, u);
    if (ms > 0) return ms;
  }
  return -1;
}
function delayOnce(apiPort, tag, testUrl) {
  return new Promise(resolve => {
    const p = `/proxies/${tag}/delay?timeout=6000&url=${encodeURIComponent(testUrl)}`;
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
  else if (act === 'max') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
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
  const parsed = parseMany(text);
  const errors = parsed.errors;
  const have = new Set(store.servers.map(x => x.raw.toLowerCase()));
  const servers = parsed.servers.filter(x => !have.has(x.raw.toLowerCase()));
  if (!servers.length && parsed.servers.length) throw new Error('ALREADY_ADDED');
  if (!servers.length) throw new Error('NO_VALID_LINKS' + (errors[0] ? ': ' + errors[0].error : ''));
  store.servers.push(...servers);
  const usable = servers.find(x => x.protocol !== 'mtproto');
  if (usable && (!store.selected || !store.servers.find(s => s.id === store.selected) || store.engine !== 'server')) { store.selected = usable.id; store.engine = 'server'; }
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
ipcMain.handle('fetch-free', () => fetchFreeServers());
ipcMain.handle('remove-free', async () => {
  if (state.status === 'connected' && state.server && (store.servers.find(s => s.id === state.server.id) || {}).free) await disconnect();
  store.servers = store.servers.filter(s => !s.free);
  if (!store.servers.find(s => s.id === store.selected)) store.selected = (store.servers.find(s => s.protocol !== 'mtproto') || {}).id || null;
  save();
  return publicStore();
});

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
  patch = Object.assign({}, patch || {});
  if ('alwaysAdmin' in patch) {
    const r = await setAlwaysAdmin(!!patch.alwaysAdmin);
    delete patch.alwaysAdmin;
    if (!r.ok) send('toast', r.cancelled ? 'ADMIN_CANCELLED' : 'ADMIN_FAILED');
  }
  const before = Object.assign({}, store.settings);
  Object.assign(store.settings, patch);
  save();
  if ('autoStart' in (patch || {})) applyAutoStart();
  const needsReconnect = ['mode', 'routing', 'blockAds', 'dns', 'socialDirect'].some(k => k in (patch || {}) && before[k] !== store.settings[k]);
  if (needsReconnect && state.status === 'connected') { await disconnect(); await connect(); }
  refreshTray();
  return publicStore();
});

ipcMain.handle('open', (_e, url) => { if (/^(https?:|tg:)/.test(url)) shell.openExternal(url); });
ipcMain.handle('open-logs', () => shell.openPath(RUN_DIR));

// ---------------- browser extension helper ----------------
function extensionDir(kind) {
  const c = [path.join(process.resourcesPath || '', 'extension', kind), path.join(__dirname, '..', 'extension', kind)];
  return c.find(p => fs.existsSync(p)) || c[1];
}
const BROWSERS = [
  { id: 'chrome', name: 'Google Chrome', page: 'chrome://extensions/', kind: 'chromium',
    paths: ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe', '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe'] },
  { id: 'edge', name: 'Microsoft Edge', page: 'edge://extensions/', kind: 'chromium',
    paths: ['%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe'] },
  { id: 'brave', name: 'Brave', page: 'brave://extensions/', kind: 'chromium',
    paths: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', '%LocalAppData%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'] },
  { id: 'opera', name: 'Opera', page: 'opera://extensions/', kind: 'chromium',
    paths: ['%LocalAppData%\\Programs\\Opera\\opera.exe', '%LocalAppData%\\Programs\\Opera GX\\opera.exe', '%ProgramFiles%\\Opera\\opera.exe'] },
  { id: 'vivaldi', name: 'Vivaldi', page: 'vivaldi://extensions/', kind: 'chromium',
    paths: ['%LocalAppData%\\Vivaldi\\Application\\vivaldi.exe', '%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe'] },
  { id: 'yandex', name: 'Yandex', page: 'browser://extensions/', kind: 'chromium',
    paths: ['%LocalAppData%\\Yandex\\YandexBrowser\\Application\\browser.exe'] },
  { id: 'firefox', name: 'Firefox', page: 'about:debugging#/runtime/this-firefox', kind: 'firefox',
    paths: ['%ProgramFiles%\\Mozilla Firefox\\firefox.exe', '%ProgramFiles(x86)%\\Mozilla Firefox\\firefox.exe'] }
];
const expandEnv = p => p.replace(/%([^%]+)%/g, (_m, k) => process.env[k] || process.env[k.toUpperCase()] || '');
function findBrowser(b) { return b.paths.map(expandEnv).find(p => p && fs.existsSync(p)) || null; }

ipcMain.handle('browsers', () => BROWSERS.map(b => ({ id: b.id, name: b.name, installed: !!findBrowser(b), kind: b.kind, auto: b.kind === 'chromium' && !!extInstallerExe(), extDone: (store.extInstalled || []).includes(b.id) })));
ipcMain.handle('install-extension', (_e, id) => {
  const b = BROWSERS.find(x => x.id === id);
  if (!b) return { ok: false };
  const dir = extensionDir(b.kind);
  const target = b.kind === 'firefox' ? path.join(dir, 'manifest.json') : dir;
  clipboard.writeText(target);
  shell.openPath(dir);
  const exe = findBrowser(b);
  if (exe) { try { spawn(exe, [b.page], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); } catch {} }
  return { ok: true, dir, target, page: b.page, kind: b.kind, found: !!exe };
});

// ---------------- automatic extension install (same method as IBDM Pro) ----------------
// A small helper drives the browser by itself: extensions page → developer mode → Load unpacked → our folder.
// While it works a "don't touch anything" card stays on top of the screen; Esc stops it.
function extInstallerExe() {
  const c = [path.join(process.resourcesPath || '', 'tools', 'ibra-ext-installer.exe'), path.join(__dirname, '..', 'tools', 'ext-installer', 'out', 'ibra-ext-installer.exe')];
  return c.find(p => fs.existsSync(p)) || null;
}
const EXT_STEPS = {
  ar: { open: 'فتح المتصفح على صفحة الإضافات…', type: 'كتابة عنوان صفحة الإضافات…', dev: 'تفعيل «وضع المطوّر»…', load: 'الضغط على «تحميل إضافة غير مُجمَّعة»…', folder: 'اختيار مجلد الإضافة…', wait: 'التأكد من اتصال الإضافة بالبرنامج…' },
  en: { open: 'Opening the browser extensions page…', type: 'Typing the extensions page address…', dev: 'Turning on Developer mode…', load: 'Pressing “Load unpacked”…', folder: 'Choosing the extension folder…', wait: 'Checking the extension talks to the app…' }
};
const EXT_FAIL = {
  ar: { NO_PAGE: 'ما لگيت صفحة الإضافات أو زر «وضع المطوّر».', NO_LOAD: 'ما لگيت زر «تحميل إضافة غير مُجمَّعة».', NO_DIALOG: 'ما ظهرت نافذة اختيار المجلد.', NO_FOLDER_BOX: 'ما لگيت خانة المجلد بنافذة الاختيار.', NO_DIR: 'مجلد الإضافة مو موجود.', NO_BROWSER: 'المتصفح مو منصّب.', CANCELLED: 'تم الإيقاف.', NO_TOOL: 'أداة التنصيب التلقائي مو موجودة.' },
  en: { NO_PAGE: 'Could not find the extensions page or the Developer mode switch.', NO_LOAD: 'Could not find “Load unpacked”.', NO_DIALOG: 'The folder dialog did not appear.', NO_FOLDER_BOX: 'Could not find the folder box in the dialog.', NO_DIR: 'Extension folder missing.', NO_BROWSER: 'Browser not installed.', CANCELLED: 'Stopped.', NO_TOOL: 'Automatic install helper missing.' }
};
let extJob = null;

function extOverlay() {
  const o = new BrowserWindow({
    width: 560, height: 330, frame: false, transparent: true, resizable: false, movable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false, webPreferences: { contextIsolation: true }
  });
  o.setAlwaysOnTop(true, 'screen-saver');
  o.setIgnoreMouseEvents(true);
  o.loadFile(path.join(__dirname, 'renderer', 'ext-overlay.html'), { query: { lang: store.settings.lang === 'ar' ? 'ar' : 'en' } });
  o.once('ready-to-show', () => o.showInactive());
  return o;
}

function runExtInstaller(b, exe, onStep) {
  return new Promise(resolve => {
    const tool = extInstallerExe();
    if (!tool) return resolve({ ok: false, code: 'NO_TOOL' });
    const proc = path.basename(exe, '.exe');
    const child = spawn(tool, [proc, exe, b.page.replace(/\/$/, ''), extensionDir('chromium')], { windowsHide: true });
    extJob.child = child;
    let buf = '', result = null;
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/^\uFEFF/, '').trim(); buf = buf.slice(i + 1);
        if (line.startsWith('STEP ')) onStep(line.slice(5).trim());
        else if (line === 'OK') result = { ok: true };
        else if (line.startsWith('FAIL ')) { const [code, ...rest] = line.slice(5).split(' '); result = { ok: false, code, detail: rest.join(' ') }; }
        log(`extension auto-install (${b.id}): ${line}`);
      }
    });
    child.on('error', e => { result = { ok: false, code: 'ERROR', detail: e.message }; });
    child.on('close', () => resolve(extJob && extJob.cancelled ? { ok: false, code: 'CANCELLED' } : (result || { ok: false, code: 'ERROR' })));
  });
}

async function autoInstallExtensions(ids) {
  if (extJob) return { busy: true };
  const L = store.settings.lang === 'ar' ? 'ar' : 'en';
  const list = BROWSERS.filter(b => b.kind === 'chromium' && (!ids || ids === 'all' || ids.includes(b.id)))
    .map(b => ({ b, exe: findBrowser(b) })).filter(x => x.exe);
  if (!list.length) return { results: [], none: true };
  extJob = { cancelled: false, child: null };
  const overlay = extOverlay();
  const show = (title, steps) => { try { overlay.webContents.executeJavaScript(`window.ibraSet(${JSON.stringify(title)}, ${JSON.stringify(steps)})`).catch(() => {}); } catch {} };
  try { globalShortcut.register('Escape', () => { if (extJob) { extJob.cancelled = true; try { extJob.child && extJob.child.kill(); } catch {} } }); } catch {}
  const results = [];
  for (const { b, exe } of list) {
    if (extJob.cancelled) break;
    const title = L === 'ar' ? `جاري تنصيب الإضافة على ${b.name}` : `Installing the extension on ${b.name}`;
    const steps = [];
    show(title, steps);
    send('ext-progress', { id: b.id, state: 'working' });
    const started = Date.now();
    const r = await runExtInstaller(b, exe, step => { steps.push(EXT_STEPS[L][step] || step); show(title, steps); });
    if (r.ok) {
      // the extension calls the app as soon as it starts: wait for that to confirm it really runs
      steps.push(EXT_STEPS[L].wait); show(title, steps);
      const end = Date.now() + 20000;
      while (Date.now() < end && bridge.lastContact() < started && !extJob.cancelled) await new Promise(res => setTimeout(res, 500));
      r.confirmed = bridge.lastContact() >= started;
    }
    r.message = r.ok
      ? (r.confirmed ? (L === 'ar' ? 'تم التنصيب والإضافة متصلة بالبرنامج ✓' : 'Installed and connected ✓') : (L === 'ar' ? 'تم التنصيب. إذا ما ظهرت الأيقونة سكّر المتصفح وافتحه.' : 'Installed. If the icon is missing, restart the browser.'))
      : ((EXT_FAIL[L][r.code] || r.code) + (L === 'ar' ? ' جرّب الخطوات اليدوية.' : ' Try the manual steps.'));
    results.push({ id: b.id, name: b.name, ok: r.ok, confirmed: !!r.confirmed, message: r.message });
    send('ext-progress', { id: b.id, state: r.ok ? 'done' : 'failed', message: r.message });
  }
  try { globalShortcut.unregister('Escape'); } catch {}
  try { overlay.destroy(); } catch {}
  extJob = null;
  if (results.some(x => x.ok)) { store.extInstalled = Array.from(new Set([...(store.extInstalled || []), ...results.filter(x => x.ok).map(x => x.id)])); save(); }
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  return { results };
}
ipcMain.handle('auto-install-extension', (_e, ids) => autoInstallExtensions(ids));

function readRegValue(name) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', 'HKCU\\Software\\IBRA VPN', '/v', name], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = new RegExp(name + '\\s+REG_\\w+\\s+(\\S+)').exec(String(out));
      resolve(m ? m[1] : null);
    });
  });
}
function clearRegValue(name) {
  if (process.platform !== 'win32') return;
  execFile('reg', ['delete', 'HKCU\\Software\\IBRA VPN', '/v', name, '/f'], { windowsHide: true }, () => {});
}

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
function readInstallMode() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', 'HKCU\\Software\\IBRA VPN', '/v', 'InstallMode'], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = /InstallMode\s+REG_SZ\s+(\w+)/.exec(String(out));
      resolve(m ? m[1].toLowerCase() : null);
    });
  });
}

app.whenReady().then(async () => {
  const argv = process.argv.slice();
  // "always as administrator": hand over to the elevated copy without a UAC prompt
  if (process.platform === 'win32' && app.isPackaged && store.settings.alwaysAdmin && !ELEVATED_LAUNCH && !(await isAdmin())) {
    writePending({ hidden: argv.includes('--hidden'), connect: argv.includes('--connect'), url: argv.find(a => /^ibravpn:/i.test(a)) || null });
    if (await elevation.runTask()) { app.exit(0); return; }
  }
  if (argv.includes('--enable-admin') && await isAdmin()) {
    store.settings.alwaysAdmin = await elevation.registerTask(process.execPath); save();
  }
  const pending = argv.includes('--elevated') ? readPending() : {};
  if (pending.url) argv.push(pending.url);

  // installer choice: full (whole PC) or browsers only
  const installMode = await readInstallMode();
  if (installMode && installMode !== store.appliedInstallMode) {
    if (installMode === 'browser') store.settings.mode = 'browser';
    else if (store.settings.mode === 'browser') store.settings.mode = 'proxy';
    store.appliedInstallMode = installMode; save();
  }

  // a crash last time may have left our system proxy on
  if (store.lastProxyPort) { await sysproxy.disable(store.lastProxyPort).catch(() => {}); store.lastProxyPort = null; save(); }
  if (app.isPackaged) { try { app.setAsDefaultProtocolClient('ibravpn'); } catch {} }
  bridge.start({
    getStatus: () => ({
      app: 'IBRA VPN', version: app.getVersion(), status: state.status, mode: store.settings.mode,
      port: state.status === 'connected' ? state.mixedPort : null,
      server: state.server ? state.server.name : null, ip: state.ip && !state.ip.failed ? state.ip : null
    }),
    connect: async () => { await connect(); },
    disconnect: async () => { await disconnect(); },
    log
  });
  const hidden = argv.includes('--hidden') || pending.hidden || store.settings.startHidden || argv.some(a => /^ibravpn:\/\/(connect|disconnect)/i.test(a));
  createWindow(!hidden);
  createTray();
  applyAutoStart();
  const byProtocol = handleProtocol(argv);
  if (!byProtocol && (store.settings.autoConnect || argv.includes('--connect') || pending.connect)) setTimeout(connect, 800);
  if (store.settings.autoUpdate) setTimeout(() => checkUpdates(false), 5000);
  // the installer's "install the browser extension automatically" option (asked once, right after setup)
  if (await readRegValue('AutoExtension') === '1') {
    clearRegValue('AutoExtension');
    setTimeout(async () => {
      const r = await autoInstallExtensions('all');
      if (r && r.results && r.results.length) send('ext-auto-result', r);
    }, 3500);
  }
});

app.on('before-quit', () => { quitting = true; cleanupSync(); });
app.on('window-all-closed', () => { if (process.platform !== 'win32' || !store.settings.closeToTray) app.quit(); });
process.on('exit', cleanupSync);
