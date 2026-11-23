'use strict';
/* IBRA VPN renderer — برمجة وتطوير ابراهيم الخزرجي */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

let S = null;            // store snapshot from main
let lang = 'ar';
const pings = {};        // id -> ms
let timerInt = null;

const T = k => (I18N[lang] && I18N[lang][k]) ?? I18N.ar[k] ?? k;

function fmtBytes(n, perSec) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; n = n || 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i] + (perSec ? '/s' : '');
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast show ' + (kind || '');
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = 'toast'), 2600);
}

function errText(code) {
  if (!code) return '';
  const key = String(code).split(':')[0];
  const e = T('err');
  return (e && e[key]) ? e[key] + (code.includes(':') && key !== 'NO_VALID_LINKS' ? '' : '') : code;
}

function modal(text, { input, buttons }) {
  return new Promise(resolve => {
    $('#modalText').textContent = text;
    const inp = $('#modalInput');
    inp.hidden = input === undefined;
    if (input !== undefined) { inp.value = input; setTimeout(() => inp.select(), 30); }
    const box = $('#modalBtns'); box.innerHTML = '';
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.className = b.cls || 'ghost'; el.textContent = b.label;
      el.onclick = () => { $('#modal').hidden = true; resolve(b.value === 'input' ? inp.value : b.value); };
      box.appendChild(el);
    });
    $('#modal').hidden = false;
  });
}
const confirmBox = text => modal(text, { buttons: [{ label: T('cancel'), value: false }, { label: T('ok'), value: true, cls: 'primary danger-bg' }] });

/* ---------------- i18n & theme ---------------- */
function applyLang() {
  const langChanged = document.documentElement.lang && document.documentElement.lang !== (S.settings.lang || 'ar');
  lang = S.settings.lang || 'ar';
  document.documentElement.lang = lang;
  if (langChanged && window.IbraStoreSlider) window.IbraStoreSlider.reload();
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  $$('[data-i]').forEach(el => { const v = T(el.dataset.i); if (typeof v === 'string') el.textContent = v; });
  $$('[data-ip]').forEach(el => { el.placeholder = T(el.dataset.ip); });
}

const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  let th = S.settings.theme || 'red';
  if (th === 'system') th = darkMQ.matches ? 'red' : 'light';
  document.documentElement.dataset.theme = th;
}
darkMQ.addEventListener('change', () => S && applyTheme());

/* ---------------- render ---------------- */
function setSeg(sel, val) { $$(sel + ' button').forEach(b => b.classList.toggle('on', (b.dataset.v || b.dataset.engine) === val)); }

const PROTO = { vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'SS', hysteria2: 'HY2', tuic: 'TUIC', socks: 'SOCKS5', http: 'HTTP', mtproto: 'MTProto', warp: 'WARP', bypass: 'DPI' };

function pingHtml(ms) {
  if (ms === undefined || ms === null) return '';
  if (ms === -2) return `<span class="ping wait">···</span>`;
  if (ms < 0) return `<span class="ping bad">${esc(T('timeout'))}</span>`;
  const c = ms < 300 ? 'good' : ms < 800 ? 'mid' : 'slow';
  return `<span class="ping ${c}">${ms} ms</span>`;
}

function renderHome() {
  const st = S.state;
  setSeg('#engineSeg', S.engine);
  const app = $('.app');
  app.dataset.status = st.status;
  $('#statusText').textContent = T({ connected: 'stConnected', connecting: 'stConnecting', disconnecting: 'stDisconnecting' }[st.status] || 'stDisconnected');

  // error
  const eb = $('#errorBox');
  if (st.error && st.status === 'disconnected') {
    eb.hidden = false;
    eb.innerHTML = esc(errText(st.error));
    if (st.error === 'NEED_ADMIN') {
      eb.innerHTML += `<div class="row"><button class="primary small" id="adminBtn">${esc(T('runAdmin'))}</button><button class="ghost small" id="proxyBtn">${esc(T('useProxyMode'))}</button></div>`;
      $('#adminBtn').onclick = () => vpn.adminRelaunch();
      $('#proxyBtn').onclick = async () => { S = await vpn.settings({ mode: 'proxy' }); render(); vpn.connect(); };
    }
  } else eb.hidden = true;

  // server card
  let name, sub, proto, id;
  if (S.engine === 'warp') { name = T('warpName'); sub = T('warpDesc'); proto = 'warp'; id = 'warp'; }
  else if (S.engine === 'bypass') { name = T('bypassName'); sub = T('bypassDesc'); proto = 'bypass'; id = 'bypass'; }
  else {
    const vs = S.servers.filter(x => x.protocol !== 'mtproto');
    const s = vs.find(x => x.id === S.selected) || vs[0];
    if (s) { name = s.name; sub = `${PROTO[s.protocol] || s.protocol} · ${s.outbound.server}`; proto = s.protocol; id = s.id; }
    else { name = T('noServer'); sub = T('tapToChoose'); proto = ''; }
  }
  $('#scName').textContent = name;
  $('#scSub').textContent = sub;
  $('#scIcon').textContent = PROTO[proto] || '+';
  $('#scPing').innerHTML = (st.status === 'connected' && st.latency) ? pingHtml(st.latency) : id ? pingHtml(pings[id] ?? (S.servers.find(x => x.id === id) || {}).ping) : '';

  // ip
  if (st.status === 'connected' && st.ip && st.ip.failed) {
    $('#ipFlag').textContent = '🛡️';
    $('#ipCountry').textContent = T('ipFailed');
    $('#ipAddr').textContent = '—';
  } else if (st.status === 'connected' && st.ip) {
    $('#ipFlag').textContent = st.ip.flag || '🌐';
    $('#ipCountry').textContent = [st.ip.country, st.ip.city].filter(Boolean).join(' · ');
    $('#ipAddr').textContent = st.ip.ip;
  } else {
    $('#ipFlag').textContent = st.status === 'connected' ? '⏳' : '🔓';
    $('#ipCountry').textContent = st.status === 'connected' ? '…' : T('ipHidden');
    $('#ipAddr').textContent = '—';
  }
  $('#ipRefresh').hidden = st.status !== 'connected';

  $('#homeFetch').hidden = !(S.engine === 'server' && !S.servers.some(x => x.protocol !== 'mtproto') && st.status === 'disconnected');
  setSeg('#modeSeg', S.settings.mode);
  $('#modeHint').textContent = (T('modeHints') || {})[S.settings.mode] || '';
  setSeg('#routeSeg', S.settings.routing);
  $('#routeSeg').classList.toggle('disabled', S.engine === 'bypass');
  $('#adsToggle').checked = !!S.settings.blockAds;
  $('#socialToggle').checked = !!S.settings.socialDirect;
  $('#socialToggle').closest('.qrow').classList.toggle('disabled', S.engine === 'bypass');
  const wb = $('#warnBox');
  wb.hidden = !(st.status === 'connected' && st.warning);
  if (!wb.hidden) wb.textContent = T('warn')[st.warning] || st.warning;

  if (st.status !== 'connected') { $('#sDown').textContent = '0 B/s'; $('#sUp').textContent = '0 B/s'; }
  tickTimer();
}

function tickTimer() {
  clearInterval(timerInt);
  const upd = () => {
    const since = S.state.since;
    if (!since) { $('#timer').textContent = '00:00:00'; return; }
    const s = Math.floor((Date.now() - since) / 1000);
    $('#timer').textContent = [s / 3600, (s % 3600) / 60, s % 60].map(v => String(Math.floor(v)).padStart(2, '0')).join(':');
  };
  upd();
  if (S.state.since) timerInt = setInterval(upd, 1000);
}

function renderServers() {
  // subscriptions
  $('#subsList').innerHTML = S.subscriptions.map(sb => `
    <div class="sub" data-id="${esc(sb.id)}">
      <svg viewBox="0 0 24 24"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>
      <div class="grow"><b>${esc(sb.name)}</b><small>${esc(T('subscription'))} · ${sb.count} ${esc(T('servers_n'))}${sb.updatedAt ? ' · ' + new Date(sb.updatedAt).toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' }) : ''}</small></div>
      <button class="icon" data-act="sub-up" title="${esc(T('update'))}"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>
      <button class="icon danger" data-act="sub-del" title="${esc(T('delete'))}"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
    </div>`).join('');

  const list = $('#serverList');
  const tg = S.servers.filter(s => s.protocol === 'mtproto');
  const vpnList = S.servers.filter(s => s.protocol !== 'mtproto');
  $('#tgList').innerHTML = tg.length ? `<h3>${esc(T('tgProxies'))}</h3><small class="hint tg-hint">${esc(T('tgHint'))}</small>` + tg.map(s => `
    <div class="srv mt" data-id="${esc(s.id)}">
      <span class="badge tgb">TG</span>${s.free ? `<span class="badge free">${esc(T('freeTag'))}</span>` : ''}
      <div class="grow"><b>${esc(s.name)}</b><small>${esc(s.outbound.server)}:${s.outbound.server_port}</small></div>
      <span class="p">${pingHtml(pings[s.id] ?? s.ping)}</span>
      <button class="primary small" data-act="tg">${esc(T('connectTg'))}</button>
      <button class="icon more" data-act="menu">⋮</button>
    </div>`).join('') : '';
  list.innerHTML = vpnList.map(s => {
    const sel = S.engine === 'server' && s.id === S.selected;
    const ms = pings[s.id] ?? s.ping;
    return `<div class="srv ${sel ? 'sel' : ''} ${s.protocol === 'mtproto' ? 'mt' : ''}" data-id="${esc(s.id)}">
      <i class="radio"></i>
      <span class="badge">${esc(PROTO[s.protocol] || s.protocol)}</span>${s.free ? `<span class="badge free">${esc(T('freeTag'))}</span>` : ''}
      <div class="grow"><b>${esc(s.name)}</b><small>${esc(s.outbound.server)}:${s.outbound.server_port}</small></div>
      <span class="p">${pingHtml(ms)}</span>
      <button class="icon more" data-act="menu">⋮</button>
    </div>`;
  }).join('');
  $('#emptyList').hidden = vpnList.length > 0;
  $('#freeDelBtn').hidden = !S.servers.some(x => x.free);
}

function renderSettings() {
  setSeg('#langSeg', S.settings.lang);
  $$('#themeSel button').forEach(b => b.classList.toggle('on', b.dataset.v === S.settings.theme));
  $('#dnsSel').value = S.settings.dns;
  $$('[data-set]').forEach(el => { el.checked = !!S.settings[el.dataset.set]; });
  $('#portIn').value = S.settings.mixedPort;
  $('#warpHost').innerHTML = S.warpEndpoints.map(h => `<option ${h === S.warpEndpoint.host ? 'selected' : ''}>${h}</option>`).join('');
  $('#warpPort').innerHTML = S.warpPorts.map(p => `<option ${p === S.warpEndpoint.port ? 'selected' : ''}>${p}</option>`).join('');
  $('#ver').textContent = 'v' + S.version;
}

function render() { applyTheme(); applyLang(); renderHome(); renderServers(); renderSettings(); }

/* ---------------- events ---------------- */
$$('[data-win]').forEach(b => (b.onclick = () => vpn.win(b.dataset.win)));

function go(page) {
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
}
$$('.tabs button').forEach(b => (b.onclick = () => go(b.dataset.page)));

$('#power').onclick = () => {
  const st = S.state.status;
  if (st === 'connecting' || st === 'disconnecting') return;
  if (S.engine === 'server' && !S.servers.some(x => x.protocol !== 'mtproto')) { go('servers'); toast(errText('NO_SERVER')); return; }
  vpn.toggle();
};

$$('#engineSeg button').forEach(b => (b.onclick = async () => {
  S = await vpn.select({ engine: b.dataset.engine }); render();
}));
$('#serverCard').onclick = () => { if (S.engine === 'server') go('servers'); };

$$('#modeSeg button').forEach(b => (b.onclick = async () => { S = await vpn.settings({ mode: b.dataset.v }); render(); }));
$$('#routeSeg button').forEach(b => (b.onclick = async () => { S = await vpn.settings({ routing: b.dataset.v }); render(); }));
$('#adsToggle').onchange = async e => { S = await vpn.settings({ blockAds: e.target.checked }); render(); };
$('#socialToggle').onchange = async e => { S = await vpn.settings({ socialDirect: e.target.checked }); render(); };
$('#ipRefresh').onclick = () => vpn.checkIp();

// servers page
$('#pasteBtn').onclick = async () => { $('#addInput').value = await vpn.clipboard(); $('#addInput').focus(); };
$('#addBtn').onclick = async () => {
  const btn = $('#addBtn'); btn.disabled = true;
  try {
    const r = await vpn.add($('#addInput').value);
    S = r.store; render();
    $('#addInput').value = '';
    toast((r.sub ? T('addedSub')(r.added) : T('added')(r.added)) + (r.errors ? T('someBad')(r.errors) : ''), 'ok');
    vpn.test();
  } catch (e) {
    const m = String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(errText(m), 'bad');
  } finally { btn.disabled = false; }
};
async function fetchFree() {
  go('servers');
  const b = $('#fetchBtn'); b.disabled = true; $('#homeFetch').disabled = true;
  $('#fetchProg').hidden = false; $('#fetchBar').style.width = '3%'; $('#fetchText').textContent = T('fetchDownloading');
  try {
    const r = await vpn.fetchFree();
    if (r.busy) return;
    S = r.store; render();
    toast(T('fetchDone')(r.vpn, r.tg), r.vpn + r.tg ? 'ok' : 'bad');
  } catch (e) {
    toast(T('err').FETCH_FAILED, 'bad');
  } finally {
    b.disabled = false; $('#homeFetch').disabled = false;
    setTimeout(() => ($('#fetchProg').hidden = true), 1500);
  }
}
$('#fetchBtn').onclick = fetchFree;
$('#homeFetch').onclick = fetchFree;
$('#freeDelBtn').onclick = async () => { S = await vpn.removeFree(); render(); };
vpn.on('fetch-progress', p => {
  if (p.stage === 'download') { $('#fetchText').textContent = T('fetchDownloading'); $('#fetchBar').style.width = '6%'; }
  else if (p.stage === 'test') { const pc = p.total ? Math.round(p.done / p.total * 100) : 0; $('#fetchBar').style.width = Math.max(6, pc) + '%'; $('#fetchText').textContent = T('fetchTesting')(p.done, p.total, p.alive); }
  else if (p.stage === 'done') { $('#fetchBar').style.width = '100%'; $('#fetchText').textContent = T('fetchDone')(p.vpn, p.tg); }
});
$('#testAll').onclick = () => { toast(T('testing')); vpn.test(); };
$('#sortBtn').onclick = async () => { S = await vpn.sort(); render(); };
$('#bestBtn').onclick = async () => { S = await vpn.best(); render(); go('home'); };
$('#deadBtn').onclick = async () => { S = await vpn.removeDead(); render(); };

$('#subsList').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.closest('.sub').dataset.id;
  if (b.dataset.act === 'sub-up') {
    b.classList.add('spin');
    const r = await vpn.subUpdate(id); S = r.store; render();
    toast(r.failed ? errText('SUB_FAILED') : T('updated')(r.added), r.failed ? 'bad' : 'ok');
    if (!r.failed) vpn.test();
  } else if (b.dataset.act === 'sub-del') {
    if (await confirmBox(T('confirmSub'))) { S = await vpn.subRemove(id); render(); }
  }
};

const onListClick = async e => {
  const row = e.target.closest('.srv'); if (!row) return;
  const id = row.dataset.id;
  const s = S.servers.find(x => x.id === id);
  if (e.target.closest('[data-act="menu"]')) {
    const btns = [];
    if (s.protocol === 'mtproto') btns.push({ label: T('openTg'), value: 'tg', cls: 'primary' });
    btns.push({ label: T('test'), value: 'test' }, { label: T('rename'), value: 'rename' }, { label: T('copyLink'), value: 'copy' }, { label: T('delete'), value: 'del', cls: 'ghost danger' }, { label: T('cancel'), value: null });
    const act = await modal(s.name, { buttons: btns });
    if (act === 'tg') vpn.openTelegram(id);
    else if (act === 'test') vpn.test([id]);
    else if (act === 'copy') { await vpn.share(id); toast(T('copied'), 'ok'); }
    else if (act === 'rename') {
      const name = await modal(T('rename'), { input: s.name, buttons: [{ label: T('cancel'), value: null }, { label: T('save'), value: 'input', cls: 'primary' }] });
      if (name) { S = await vpn.rename({ id, name }); render(); }
    } else if (act === 'del') {
      if (await confirmBox(T('confirmDelete'))) { S = await vpn.remove(id); render(); toast(T('deleted')); }
    }
    return;
  }
  if (s.protocol === 'mtproto') { vpn.openTelegram(id); toast(T('openingTg'), 'ok'); return; }
  S = await vpn.select({ engine: 'server', id }); render();
};

$('#serverList').onclick = onListClick;
$('#tgList').onclick = onListClick;

// settings
$$('#langSeg button').forEach(b => (b.onclick = async () => { S = await vpn.settings({ lang: b.dataset.v }); render(); }));
$$('#themeSel button').forEach(b => (b.onclick = async () => { S = await vpn.settings({ theme: b.dataset.v }); render(); }));
$('#dnsSel').onchange = async e => { S = await vpn.settings({ dns: e.target.value }); render(); };
$$('[data-set]').forEach(el => (el.onchange = async () => { S = await vpn.settings({ [el.dataset.set]: el.checked }); render(); }));
$('#portIn').onchange = async e => {
  const p = parseInt(e.target.value, 10);
  if (p >= 1024 && p <= 65000) { S = await vpn.settings({ mixedPort: p, apiPort: p + 1 }); render(); }
};
const sendWarpEp = async () => { S = await vpn.warpEndpoint({ host: $('#warpHost').value, port: $('#warpPort').value }); render(); };
$('#warpHost').onchange = sendWarpEp; $('#warpPort').onchange = sendWarpEp;
$('#warpReset').onclick = async () => { S = await vpn.warpReset(); render(); toast('WARP ✓', 'ok'); };
$('#logsFolder').onclick = () => vpn.openLogs();
$('#updBtn').onclick = () => { $('#updText').textContent = '…'; vpn.checkUpdate(); };

$$('[data-open]').forEach(b => (b.onclick = () => vpn.open(b.dataset.open)));

/* ---------------- main → renderer ---------------- */
vpn.on('state', st => { const prev = S.state.status; S.state = st; renderHome(); if (prev !== st.status && st.status === 'connected') toast(T('stConnected'), 'ok'); });
vpn.on('traffic', t => {
  $('#sDown').textContent = fmtBytes(t.down, true);
  $('#sUp').textContent = fmtBytes(t.up, true);
  $('#sTotal').textContent = fmtBytes(t.upTotal + t.downTotal);
});
vpn.on('ping', ({ id, ms }) => {
  pings[id] = ms;
  const s = S.servers.find(x => x.id === id); if (s && ms !== -2) s.ping = ms;
  const cell = document.querySelector(`.srv[data-id="${CSS.escape(id)}"] .p`);
  if (cell) cell.innerHTML = pingHtml(ms);
  renderHome();
});
const logs = [];
vpn.on('log', l => {
  logs.push(l); if (logs.length > 300) logs.shift();
  const el = $('#logs'); el.textContent = logs.join('\n'); el.scrollTop = el.scrollHeight;
});
vpn.on('toast', code => toast((T('toasts') || {})[code] || code, 'bad'));

async function renderBrowsers() {
  const list = await vpn.browsers();
  const autoable = list.filter(b => b.installed && b.auto);
  $('#extList').innerHTML = (autoable.length ? `
    <button class="primary ext-all" data-auto="all">${esc(T('extAutoAll')(autoable.length))}</button>` : '') + list.map(b => `
    <div class="ext-row">
      <span class="ext-name">${esc(b.name)}${b.extDone ? ' <b class="ext-ok">✓</b>' : ''}${b.installed ? '' : ` <small>· ${esc(T('extMissing'))}</small>`}</span>
      <span class="ext-btns">
        ${b.installed && b.auto ? `<button class="primary small" data-auto="${esc(b.id)}">${esc(T('extAuto'))}</button>` : ''}
        <button class="ghost small" data-ext="${esc(b.id)}">${esc(b.installed && b.auto ? T('extManual') : T('extInstall'))}</button>
      </span>
    </div>`).join('');
}
function showExtResults(r) {
  if (!r || !r.results) return;
  if (!r.results.length) { toast(T('extNone'), 'bad'); return; }
  const ok = r.results.every(x => x.ok);
  const text = (ok ? T('extDoneTitle') : T('extPartTitle')) + '\n\n' + r.results.map(x => (x.ok ? '✓ ' : '✗ ') + x.name + ': ' + x.message).join('\n\n');
  modal(text, { buttons: [{ label: T('ok'), value: true, cls: 'primary' }] });
  renderBrowsers();
}
async function autoInstall(ids) {
  const ask = await confirmBox(T('extAutoAsk'));
  if (!ask) return;
  showExtResults(await vpn.autoInstallExtension(ids === 'all' ? 'all' : [ids]));
}
$('#extList').onclick = async e => {
  const a = e.target.closest('[data-auto]');
  if (a) { autoInstall(a.dataset.auto); return; }
  const b = e.target.closest('[data-ext]'); if (!b) return;
  const r = await vpn.installExtension(b.dataset.ext);
  if (!r || !r.ok) return;
  const text = r.kind === 'firefox' ? T('extStepsFirefox')(r.target) : T('extStepsChromium')(r.target).replace('{page}', r.page);
  modal(text, { buttons: [{ label: T('ok'), value: true, cls: 'primary' }] });
};
vpn.on('ext-auto-result', showExtResults);
renderBrowsers();

vpn.on('update', u => {
  const el = $('#updText');
  if (u.status === 'none') el.textContent = T('updNone');
  else if (u.status === 'downloading') el.textContent = T('updDownloading') + (u.percent ? ` ${u.percent}%` : '');
  else if (u.status === 'error') el.textContent = T('updError');
  else if (u.status === 'ready') {
    el.textContent = T('updReady')(u.version);
    const b = $('#updBtn'); b.textContent = T('installNow'); b.className = 'primary small';
    b.onclick = () => vpn.installUpdate();
  }
});

(async () => {
  S = await vpn.init();
  logs.push(...(S.logs || []));
  $('#logs').textContent = logs.join('\n');
  render();
})();
