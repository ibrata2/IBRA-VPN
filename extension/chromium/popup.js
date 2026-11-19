// IBRA VPN browser extension popup. برمجة وتطوير ابراهيم الخزرجي
const api = typeof browser !== 'undefined' ? browser : chrome;
const $ = id => document.getElementById(id);

function ask(cmd) {
  return new Promise(resolve => {
    try {
      if (typeof browser !== 'undefined') browser.runtime.sendMessage({ cmd }).then(r => resolve(r || null), () => resolve(null));
      else chrome.runtime.sendMessage({ cmd }, r => resolve(r || null));
    } catch (_) { resolve(null); }
  });
}

const MODES = { browser: 'وضع المتصفح فقط', proxy: 'بروكسي النظام — كل الحاسبة', tun: 'كل الجهاز' };
let busy = false;

function render(st) {
  const power = $('power');
  const noApp = !st || st.error === 'NO_APP';
  $('noapp').hidden = !noApp;
  power.disabled = noApp || busy;
  power.classList.toggle('busy', busy || (st && /ing$/.test(st.status || '')));
  const on = !!(st && st.status === 'connected');
  power.classList.toggle('on', on);
  const s = $('status');
  s.classList.toggle('on', on);
  if (noApp) { s.textContent = 'البرنامج مو شغال'; $('detail').textContent = ''; $('mode').textContent = ''; return; }
  s.textContent = on ? 'متصل ومحمي' : st.status === 'connecting' ? 'جاري الاتصال…' : st.status === 'disconnecting' ? 'جاري القطع…' : 'غير متصل';
  const parts = [];
  if (on && st.ip && st.ip.country) parts.push((st.ip.flag || '') + ' ' + st.ip.country);
  if (on && st.server) parts.push(st.server);
  $('detail').textContent = parts.join(' · ');
  $('mode').textContent = st.mode ? (MODES[st.mode] || '') : '';
}

async function refresh() { render(await ask('status')); }

$('power').addEventListener('click', async () => {
  const st = await ask('status');
  if (!st || st.error) return;
  busy = true; render(st);
  const r = await ask(st.status === 'connected' ? 'disconnect' : 'connect');
  busy = false; render(r);
});

$('launch').addEventListener('click', async () => {
  $('launch').textContent = 'جاري التشغيل…';
  busy = true;
  const r = await ask('launch');
  busy = false;
  $('launch').textContent = 'تشغيل البرنامج والاتصال';
  render(r);
});

refresh();
setInterval(refresh, 2500);
