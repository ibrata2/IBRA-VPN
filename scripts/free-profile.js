// Builds profiles/free.json — a sing-box profile (iPhone / Android sing-box clients) from the public free lists.
// The phone's engine tests all servers itself (urltest) and always uses the fastest working one.
// Usage: node scripts/free-profile.js <sing-box binary for validation>
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { parseMany } = require('../src/core/links');
const { RULESET_URL } = require('../src/core/config');

const SOURCES = [
  'https://raw.githubusercontent.com/barry-far/V2ray-Config/main/Sub1.txt',
  'https://raw.githubusercontent.com/MatinGhanbari/v2ray-configs/main/subscriptions/v2ray/super-sub.txt'
];
const MAX = 80;
const SB = process.argv[2] || 'sing-box';
const OUT = path.join(__dirname, '..', 'profiles', 'free.json');

const get = u => new Promise((res, rej) => https.get(u, { headers: { 'User-Agent': 'ibra-vpn' } }, r => {
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return res(get(r.headers.location));
  let b = ''; r.on('data', c => (b += c)); r.on('end', () => res(b));
}).on('error', rej));

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function build(servers) {
  const tags = servers.map((s, i) => `${String(i + 1).padStart(2, '0')} ${s.protocol} ${s.outbound.server}`.slice(0, 60));
  const outbounds = servers.map((s, i) => Object.assign(JSON.parse(JSON.stringify(s.outbound)), { tag: tags[i] }));
  const social = ['geosite-facebook', 'geosite-instagram', 'geosite-whatsapp'];
  return {
    log: { level: 'warn' },
    dns: {
      servers: [
        { tag: 'dns-remote', type: 'https', server: '1.1.1.1', detour: 'proxy' },
        { tag: 'dns-local', type: 'local' }
      ],
      rules: [{ rule_set: social, server: 'dns-local' }],
      final: 'dns-remote',
      strategy: 'ipv4_only'
    },
    inbounds: [{ type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, strict_route: true, stack: 'mixed' }],
    outbounds: [
      { type: 'selector', tag: 'proxy', outbounds: ['⚡ تلقائي — الأسرع', ...tags], default: '⚡ تلقائي — الأسرع' },
      { type: 'urltest', tag: '⚡ تلقائي — الأسرع', outbounds: tags, url: 'https://www.gstatic.com/generate_204', interval: '3m', tolerance: 80 },
      ...outbounds,
      { type: 'direct', tag: 'direct' }
    ],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' },
        { rule_set: social, outbound: 'direct' }
      ],
      rule_set: social.map(t => ({ tag: t, type: 'remote', format: 'binary', url: RULESET_URL[t], download_detour: 'direct' })),
      final: 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-local'
    },
    experimental: { cache_file: { enabled: true } }
  };
}

(async () => {
  const seen = new Set();
  let all = [];
  for (const u of SOURCES) {
    try {
      for (const s of parseMany(await get(u)).servers) {
        if (s.protocol === 'mtproto') continue;
        const k = `${s.protocol}:${s.outbound.server}:${s.outbound.server_port}`.toLowerCase();
        if (!seen.has(k)) { seen.add(k); all.push(s); }
      }
    } catch (e) { console.error('source failed', u, e.message); }
  }
  let list = shuffle(all).slice(0, MAX);
  const tmp = path.join(require('os').tmpdir(), 'ibra-free-check.json');
  // drop entries the engine rejects (bad keys / methods) until the profile is valid
  for (let guard = 0; guard < 80 && list.length; guard++) {
    const cfg = build(list);
    fs.writeFileSync(tmp, JSON.stringify(cfg));
    try { execFileSync(SB, ['check', '-c', tmp], { stdio: 'pipe' }); break; }
    catch (e) {
      const msg = String(e.stderr || e.stdout || e.message);
      const m = /outbound\[(\d+)\]/.exec(msg);
      if (!m) throw new Error('profile rejected: ' + msg.slice(0, 300));
      const idx = parseInt(m[1], 10) - 2; // [0]=selector [1]=urltest
      if (idx < 0 || idx >= list.length) throw new Error('profile rejected: ' + msg.slice(0, 300));
      list.splice(idx, 1);
    }
  }
  if (list.length < 5) throw new Error('too few servers: ' + list.length);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(build(list), null, 1));
  console.log(`profiles/free.json: ${list.length} servers (from ${all.length})`);
})().catch(e => { console.error(e); process.exit(1); });
