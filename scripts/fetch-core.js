// Downloads the sing-box engine into ./core (Windows build by default, or the host build with "host").
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const VERSION = process.env.SINGBOX_VERSION || '1.14.4';
const target = process.argv[2] === 'host' ? process.platform : 'win32';
const CORE = path.join(__dirname, '..', 'core');
const exe = target === 'win32' ? 'sing-box.exe' : 'sing-box';

if (fs.existsSync(path.join(CORE, exe)) && fs.existsSync(path.join(CORE, 'rules', 'geosite-meta.srs')) && !process.env.FORCE) { console.log('core present:', exe); process.exit(0); }
fs.mkdirSync(CORE, { recursive: true });

const name = target === 'win32' ? `sing-box-${VERSION}-windows-amd64` : `sing-box-${VERSION}-linux-amd64`;
const file = name + (target === 'win32' ? '.zip' : '.tar.gz');
const url = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${file}`;
const tmp = path.join(require('os').tmpdir(), file);

function get(u, dest, n = 0) {
  return new Promise((resolve, reject) => {
    https.get(u, { headers: { 'User-Agent': 'ibra-vpn-build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 8) { res.resume(); return resolve(get(res.headers.location, dest, n + 1)); }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' ' + u));
      const out = fs.createWriteStream(dest);
      res.pipe(out); out.on('finish', () => out.close(resolve)); out.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  console.log('downloading', url);
  await get(url, tmp);
  const x = path.join(require('os').tmpdir(), 'sb-x-' + Date.now());
  fs.mkdirSync(x);
  if (file.endsWith('.zip')) {
    if (process.platform === 'win32') {
      const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      try { execSync(`"${bsdtar}" -xf "${tmp}" -C "${x}"`); }
      catch (e) { execSync(`powershell -NoProfile -Command "Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory('${tmp}','${x}')"`); }
    }
    else execSync(`unzip -q -o "${tmp}" -d "${x}"`);
  } else execSync(`tar xzf "${tmp}" -C "${x}"`);
  const dir = path.join(x, name);
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(CORE, f));
  if (target !== 'win32') fs.chmodSync(path.join(CORE, exe), 0o755);
  // bundled rule sets (no download needed when connecting)
  const { RULESET_URL } = require('../src/core/config');
  const rules = path.join(CORE, 'rules');
  fs.mkdirSync(rules, { recursive: true });
  for (const [tag, u] of Object.entries(RULESET_URL)) { await get(u, path.join(rules, tag + '.srs')); }
  console.log('core ready:', fs.readdirSync(CORE).join(', '), '| rules:', fs.readdirSync(rules).length);
})().catch(e => { console.error(e); process.exit(1); });
