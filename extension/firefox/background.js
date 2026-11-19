// IBRA VPN extension — Firefox.
// Talks to the IBRA VPN app on this PC and routes only this browser through its local proxy.
const PORTS = [20790, 20791, 20792, 20793, 20794];
let bridgePort = null;
let proxyPort = null;

browser.proxy.onRequest.addListener(details => {
  if (!proxyPort) return { type: 'direct' };
  try {
    const h = new URL(details.url).hostname;
    if (h === '127.0.0.1' || h === 'localhost') return { type: 'direct' };
  } catch (_) {}
  return { type: 'socks', host: '127.0.0.1', port: proxyPort, proxyDNS: true };
}, { urls: ['<all_urls>'] });

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
    } catch (_) {}
  }
  throw new Error('NO_APP');
}

function apply(st) {
  proxyPort = st && st.status === 'connected' && st.port ? st.port : null;
  browser.browserAction.setBadgeText({ text: proxyPort ? 'ON' : '' });
  browser.browserAction.setBadgeBackgroundColor({ color: '#e3141c' });
}

async function status() {
  try { const st = await call('/status'); apply(st); return st; }
  catch (e) { apply(null); return { error: 'NO_APP' }; }
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
    try { await browser.tabs.create({ url: 'ibravpn://connect' }); } catch (_) {}
    const end = Date.now() + 30000;
    let st = await status();
    while (Date.now() < end && st.error) { await new Promise(r => setTimeout(r, 1000)); st = await status(); }
    return st.error ? st : waitFor('connected');
  }
  return null;
}

browser.runtime.onMessage.addListener(msg => handle(msg && msg.cmd));
setInterval(status, 10000);
status();
