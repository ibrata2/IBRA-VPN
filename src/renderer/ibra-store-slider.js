/* IBRA STORE — slideshow of the latest programs and games from https://ibraprogram.netlify.app
 * Self-contained: no libraries, its own styles. Mount: <div id="ibraStoreSlider"></div>
 * Looks: inherits the app's font, text colour and background; the main colour comes from
 * the CSS variable --ibra-accent (or the app's --accent), or from ACCENT below if you set it.
 * If loading fails, or there are no apps, the box stays hidden — no error is shown.
 */
(function () {
  'use strict';

  const ACCENT = '';                 // e.g. '#e3141c' — leave empty to use --ibra-accent / the app's colour
  const SITE = 'https://ibraprogram.netlify.app';
  const API = SITE + '/api/apps';
  const MAX = 10;                    // latest 10
  const EVERY = 4000;                // change slide every 4 seconds
  const MOUNT_ID = 'ibraStoreSlider';

  const CSS = `
#${MOUNT_ID}{--sl-accent:var(--ibra-accent,var(--accent,#e3141c));font:inherit;color:inherit;margin-top:12px}
#${MOUNT_ID}[hidden]{display:none!important}
.iss-head{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;font-weight:700;font-size:13px}
.iss-head span{opacity:.65;font-weight:600;font-size:11.5px}
.iss-box{position:relative;height:178px;border-radius:16px;overflow:hidden;background:inherit;
  border:1px solid color-mix(in srgb,var(--sl-accent) 35%,transparent);box-shadow:0 8px 26px rgba(0,0,0,.28)}
.iss-track{position:absolute;inset:0}
.iss-slide{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .6s ease,visibility .6s;cursor:pointer}
.iss-slide.on{opacity:1;visibility:visible}
.iss-bg{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.04);transition:transform 4.5s ease}
.iss-slide.on .iss-bg{transform:scale(1.12)}
.iss-bg.icon-only{filter:blur(18px) saturate(1.3);transform:scale(1.4)!important;opacity:.55}
.iss-shade{position:absolute;inset:0;background:linear-gradient(0deg,rgba(0,0,0,.88) 8%,rgba(0,0,0,.45) 55%,rgba(0,0,0,.12))}
.iss-body{position:absolute;inset:auto 0 0 0;display:flex;gap:11px;align-items:flex-end;padding:14px 16px 26px;color:#fff}
.iss-icon{width:54px;height:54px;border-radius:13px;flex:none;object-fit:cover;background:rgba(255,255,255,.08);
  border:2px solid color-mix(in srgb,var(--sl-accent) 70%,#fff 0%);box-shadow:0 4px 14px rgba(0,0,0,.45)}
.iss-text{flex:1;min-width:0}
.iss-cat{display:inline-block;font-size:10.5px;font-weight:700;padding:1px 8px;border-radius:20px;margin-bottom:3px;
  background:var(--sl-accent);color:var(--accent-ink,#fff)}
.iss-name{font-weight:800;font-size:16px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.iss-tag{font-size:12px;opacity:.85;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.iss-go{flex:none;align-self:center;font:inherit;font-size:12px;font-weight:700;padding:7px 12px;border-radius:10px;border:0;cursor:pointer;
  background:var(--sl-accent);color:var(--accent-ink,#fff);box-shadow:0 4px 14px color-mix(in srgb,var(--sl-accent) 45%,transparent);white-space:nowrap}
.iss-go:hover{filter:brightness(1.12)}
.iss-arrow{position:absolute;top:50%;transform:translateY(-70%);width:30px;height:30px;border-radius:50%;border:0;cursor:pointer;
  background:rgba(0,0,0,.45);color:#fff;font-size:18px;line-height:30px;text-align:center;opacity:0;transition:opacity .25s,background .2s;z-index:2}
.iss-box:hover .iss-arrow{opacity:1}
.iss-arrow:hover{background:var(--sl-accent)}
.iss-prev{right:8px}.iss-next{left:8px}
[dir=ltr] .iss-prev,.iss-ltr .iss-prev{right:auto;left:8px}[dir=ltr] .iss-next,.iss-ltr .iss-next{left:auto;right:8px}
.iss-dots{position:absolute;bottom:9px;left:0;right:0;display:flex;justify-content:center;gap:5px;z-index:2}
.iss-dots button{width:6px;height:6px;padding:0;border-radius:6px;border:0;cursor:pointer;background:rgba(255,255,255,.45);transition:width .3s,background .3s}
.iss-dots button.on{width:18px;background:var(--sl-accent)}
`;

  function abs(u) {
    if (!u || typeof u !== 'string') return '';
    try { const x = new URL(u, SITE + '/'); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (_) { return ''; }
  }
  const cssUrl = u => 'url("' + u.replace(/["\\\n\r]/g, encodeURIComponent) + '")';
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function openApp(slug) {
    const url = SITE + '/app/' + encodeURIComponent(slug);
    // inside the IBRA desktop apps, open in the person's browser; on a web page, a new tab
    if (window.vpn && typeof window.vpn.open === 'function') window.vpn.open(url);
    else window.open(url, '_blank', 'noopener');
  }

  async function load() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(API, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) return [];
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data && (data.apps || data.items || data.data)) || [];
      return list
        .filter(a => a && a.name && a.slug)
        .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
        .slice(0, MAX);
    } catch (_) { return []; } finally { clearTimeout(t); }
  }

  function build(root, apps) {
    if (ACCENT) root.style.setProperty('--ibra-accent', ACCENT);
    const ar = (document.documentElement.lang || 'ar').startsWith('ar') || document.documentElement.dir === 'rtl';
    if (!ar) root.classList.add('iss-ltr');
    root.textContent = '';

    const head = el('div', 'iss-head');
    head.append(el('b', null, ar ? 'آخر البرامج والألعاب' : 'Latest programs & games'), el('span', null, 'IBRA STORE'));
    const box = el('div', 'iss-box');
    const track = el('div', 'iss-track');
    const dots = el('div', 'iss-dots');
    const slides = [];

    apps.forEach((a, i) => {
      const shot = abs(Array.isArray(a.screenshots) ? a.screenshots[0] : '');
      const icon = abs(a.icon);
      const s = el('div', 'iss-slide');
      const bg = el('div', 'iss-bg' + (shot ? '' : ' icon-only'));
      if (shot || icon) bg.style.backgroundImage = cssUrl(shot || icon);
      const body = el('div', 'iss-body');
      if (icon) {
        const img = el('img', 'iss-icon');
        img.alt = ''; img.loading = 'lazy'; img.src = icon;
        img.onerror = () => img.remove();
        body.append(img);
      }
      const text = el('div', 'iss-text');
      const cat = Array.isArray(a.categories) && a.categories[0];
      if (cat) text.append(el('span', 'iss-cat', String(cat)));
      text.append(el('div', 'iss-name', String(a.name)));
      if (a.tagline) text.append(el('div', 'iss-tag', String(a.tagline)));
      const go = el('button', 'iss-go', ar ? 'عرض البرنامج ←' : 'View app →');
      go.type = 'button';
      go.onclick = e => { e.stopPropagation(); openApp(a.slug); };
      body.append(text, go);
      s.append(bg, el('div', 'iss-shade'), body);
      s.onclick = () => openApp(a.slug);
      track.append(s);
      slides.push(s);

      const d = el('button');
      d.type = 'button';
      d.setAttribute('aria-label', String(i + 1));
      d.onclick = () => { show(i); restart(); };
      dots.append(d);
    });

    let cur = 0, timer = null, paused = false;
    function show(i) {
      cur = (i + slides.length) % slides.length;
      slides.forEach((s, k) => s.classList.toggle('on', k === cur));
      [...dots.children].forEach((d, k) => d.classList.toggle('on', k === cur));
    }
    function restart() {
      clearInterval(timer);
      if (slides.length > 1) timer = setInterval(() => { if (!paused && !document.hidden) show(cur + 1); }, EVERY);
    }

    box.append(track);
    if (slides.length > 1) {
      const prev = el('button', 'iss-arrow iss-prev', ar ? '›' : '‹');
      const next = el('button', 'iss-arrow iss-next', ar ? '‹' : '›');
      prev.type = next.type = 'button';
      prev.onclick = () => { show(cur - 1); restart(); };
      next.onclick = () => { show(cur + 1); restart(); };
      box.append(prev, next, dots);
    }
    box.addEventListener('mouseenter', () => { paused = true; });
    box.addEventListener('mouseleave', () => { paused = false; });

    root.append(head, box);
    show(0);
    restart();
    root.hidden = false;
  }

  async function start() {
    const root = document.getElementById(MOUNT_ID);
    if (!root) return;
    root.hidden = true;
    if (!document.getElementById('iss-style')) {
      const st = document.createElement('style');
      st.id = 'iss-style';
      st.textContent = CSS;
      document.head.append(st);
    }
    const apps = await load();
    if (apps.length) build(root, apps);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  window.IbraStoreSlider = { reload: start };
})();
