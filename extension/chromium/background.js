// IBRA VPN extension — Chrome, Edge, Brave, Opera, Vivaldi, Yandex.
// Talks to the IBRA VPN app on this PC and routes only this browser through its local proxy.
const PORTS = [20790, 20791, 20792, 20793, 20794];
let bridgePort = null;
let applied = null; // proxy port currently set in the browser

async function call(path, method = 'GET') {
  const order = bridgePort ? [bridgePort, ...PORTS.filter(p => p !== bridgePort)] : PORTS;
  for (const p of order) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), method === 'GET' ? 1500 : 25000);
      const r = await fetch(`http://127.0.0.1:${p}${path}`, { method, signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.app === 'IBRA VPN') { bridgePort = p; return j; }
    } catch (_) { /* try next port */ }
  }
  throw new Error('NO_APP');
}

function setProxy(port) {
  return new Promise(resolve => {
    if (port) {
      chrome.proxy.settings.set({
        value: {
          mode: 'fixed_servers',
          rules: { singleProxy: { scheme: 'socks5', host: '127.0.0.1', port }, bypassList: ['localhost', '127.0.0.1', '<local>'] }
        },
        scope: 'regular'
      }, resolve);
    } else {
      chrome.proxy.settings.clear({ scope: 'regular' }, resolve);
    }
  });
}

async function apply(st) {
  const port = st && st.status === 'connected' && st.port ? st.port : null;
  if (port !== applied) { await setProxy(port); applied = port; }
  chrome.action.setBadgeText({ text: port ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#e3141c' });
}

async function status() {
  try { const st = await call('/status'); await apply(st); return st; }
  catch (e) { await apply(null); return { error: 'NO_APP' }; }
}

async function waitFor(target, ms = 20000) {
  const end = Date.now() + ms;
  let st = await status();
  while (Date.now() < end && !(st && st.status === target)) {
    await new Promise(r => setTimeout(r, 700));
    st = await status();
  }
  return st;
}

async function handle(cmd) {
  if (cmd === 'status') return status();
  if (cmd === 'connect') { try { await call('/connect', 'POST'); } catch (_) {} return waitFor('connected'); }
  if (cmd === 'disconnect') { try { await call('/disconnect', 'POST'); } catch (_) {} return waitFor('disconnected', 8000); }
  if (cmd === 'launch') {
    // starts the desktop app through its ibravpn:// link, then waits for it
    try { await chrome.tabs.create({ url: 'ibravpn://connect', active: true }); } catch (_) {}
    const end = Date.now() + 30000;
    let st = await status();
    while (Date.now() < end && st.error) { await new Promise(r => setTimeout(r, 1000)); st = await status(); }
    return st.error ? st : waitFor('connected');
  }
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  handle(msg && msg.cmd).then(reply);
  return true;
});

chrome.alarms.create('ibra-poll', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => status());
chrome.proxy.onProxyError.addListener(() => status());
chrome.runtime.onStartup.addListener(() => status());
chrome.runtime.onInstalled.addListener(() => status());
