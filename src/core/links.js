'use strict';
// IBRA VPN — share-link parser. Turns vmess/vless/trojan/ss/hy2/tuic/socks/http/tg links into server objects.

function b64decode(s) {
  s = String(s || '').trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function looksBase64(s) {
  return /^[A-Za-z0-9+/=_\-\s]+$/.test(s) && s.replace(/\s/g, '').length >= 8;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function decodeName(hash) {
  if (!hash) return '';
  try { return decodeURIComponent(hash.replace(/^#/, '')); } catch { return hash.replace(/^#/, ''); }
}

function bool(v) {
  return v === '1' || v === 'true' || v === true || v === 1;
}

// Splits "scheme://userinfo@host:port?query#name" without relying on WHATWG URL (which mangles some schemes)
function splitUrl(link) {
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/i.exec(link.trim());
  if (!m) return null;
  let rest = m[2];
  let name = '';
  const h = rest.indexOf('#');
  if (h >= 0) { name = decodeName(rest.slice(h + 1)); rest = rest.slice(0, h); }
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  rest = rest.replace(/\/+$/, '');
  let userinfo = '';
  const at = rest.lastIndexOf('@');
  if (at >= 0) { userinfo = rest.slice(0, at); rest = rest.slice(at + 1); }
  let path = '';
  const sl = rest.indexOf('/');
  if (sl >= 0) { path = rest.slice(sl); rest = rest.slice(0, sl); }
  let host = rest, port = '';
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (v6) { host = v6[1]; port = v6[2] || ''; }
  else {
    const c = rest.lastIndexOf(':');
    if (c >= 0) { host = rest.slice(0, c); port = rest.slice(c + 1); }
  }
  const params = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent(i >= 0 ? part.slice(0, i) : part);
    let v = i >= 0 ? part.slice(i + 1) : '';
    try { v = decodeURIComponent(v.replace(/\+/g, '%20')); } catch {}
    params[k] = v;
  }
  return { scheme: m[1].toLowerCase(), userinfo, host, port: parseInt(port, 10) || 0, path, params, name };
}

function transportFrom(p) {
  const type = (p.type || p.net || 'tcp').toLowerCase();
  const host = p.host || '';
  let path = p.path || '/';
  if (type === 'ws') {
    const t = { type: 'ws', path };
    if (host) t.headers = { Host: host };
    const ed = /[?&]ed=(\d+)/.exec(path);
    if (ed) {
      t.path = path.replace(/[?&]ed=\d+/, '') || '/';
      t.max_early_data = parseInt(ed[1], 10);
      t.early_data_header_name = 'Sec-WebSocket-Protocol';
    }
    return t;
  }
  if (type === 'grpc') return { type: 'grpc', service_name: p.serviceName || p.servicename || p.path || '' };
  if (type === 'httpupgrade') { const t = { type: 'httpupgrade', path }; if (host) t.host = host; return t; }
  if (type === 'http' || type === 'h2') {
    const t = { type: 'http' };
    if (host) t.host = host.split(',').map(s => s.trim()).filter(Boolean);
    if (p.path) t.path = p.path;
    return t;
  }
  if (type === 'tcp' && (p.headerType || '').toLowerCase() === 'http') {
    const t = { type: 'http', method: 'GET' };
    if (host) t.host = host.split(',').map(s => s.trim());
    if (p.path) t.path = p.path;
    return t;
  }
  if (type === 'xhttp' || type === 'splithttp' || type === 'kcp' || type === 'mkcp') {
    return { unsupported: type };
  }
  return null;
}

function tlsFrom(p, serverHost, forceTls) {
  const sec = (p.security || p.tls || '').toLowerCase();
  if (!forceTls && sec !== 'tls' && sec !== 'reality' && sec !== 'xtls') return null;
  const tls = { enabled: true, server_name: p.sni || p.peer || p.host || serverHost };
  if (bool(p.allowInsecure) || bool(p.insecure) || bool(p.allow_insecure) || bool(p.skip_cert_verify)) tls.insecure = true;
  if (p.alpn) tls.alpn = p.alpn.split(',').map(s => s.trim()).filter(Boolean);
  const fp = p.fp || p.fingerprint;
  if (fp && fp !== 'none') tls.utls = { enabled: true, fingerprint: fp === 'random' || fp === 'randomized' ? 'randomized' : fp };
  if (sec === 'reality') {
    tls.reality = { enabled: true, public_key: p.pbk || p.publicKey || '', short_id: p.sid || p.shortId || '' };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: 'chrome' };
  }
  return tls;
}

function parseVmess(link) {
  const body = link.slice('vmess://'.length).split('#')[0];
  let j;
  try { j = JSON.parse(b64decode(body)); } catch { throw new Error('vmess link is not valid'); }
  const p = {
    type: j.net || 'tcp', host: j.host || '', path: j.path || '/', headerType: j.type || '',
    security: j.tls || '', sni: j.sni || '', alpn: j.alpn || '', fp: j.fp || '', serviceName: j.path || '',
    allowInsecure: j.allowInsecure || j.skip_cert_verify || ''
  };
  const ob = {
    type: 'vmess', server: j.add, server_port: parseInt(j.port, 10), uuid: j.id,
    security: j.scy || 'auto', alter_id: parseInt(j.aid || 0, 10) || 0, packet_encoding: 'xudp'
  };
  const tr = transportFrom(p);
  if (tr && tr.unsupported) throw new Error('transport not supported: ' + tr.unsupported);
  if (tr) ob.transport = tr;
  const tls = tlsFrom(p, j.add);
  if (tls) ob.tls = tls;
  return { name: j.ps || `${j.add}:${j.port}`, protocol: 'vmess', outbound: ob };
}

function parseVlessTrojan(u, kind) {
  const p = u.params;
  const ob = { type: kind, server: u.host, server_port: u.port || 443 };
  if (kind === 'vless') {
    ob.uuid = decodeURIComponent(u.userinfo);
    if (p.flow) ob.flow = p.flow.replace('-udp443', '');
    ob.packet_encoding = 'xudp';
  } else {
    ob.password = decodeURIComponent(u.userinfo);
  }
  const tr = transportFrom(p);
  if (tr && tr.unsupported) throw new Error('transport not supported: ' + tr.unsupported);
  if (tr) ob.transport = tr;
  const tls = tlsFrom(p, u.host, kind === 'trojan' && (p.security || 'tls') !== 'none');
  if (tls) ob.tls = tls;
  return { name: u.name || `${u.host}:${ob.server_port}`, protocol: kind, outbound: ob };
}

function parseSS(link) {
  let body = link.slice('ss://'.length);
  let name = '';
  const h = body.indexOf('#');
  if (h >= 0) { name = decodeName(body.slice(h + 1)); body = body.slice(0, h); }
  body = body.split('?')[0].replace(/\/$/, '');
  let method, password, host, port;
  if (body.includes('@')) {
    const at = body.lastIndexOf('@');
    let cred = decodeURIComponent(body.slice(0, at));
    const hp = body.slice(at + 1);
    if (!cred.includes(':')) cred = b64decode(cred);
    const ci = cred.indexOf(':');
    method = cred.slice(0, ci); password = cred.slice(ci + 1);
    const c = hp.lastIndexOf(':');
    host = hp.slice(0, c).replace(/^\[|\]$/g, ''); port = parseInt(hp.slice(c + 1), 10);
  } else {
    const dec = b64decode(body);
    const m = /^([^:]+):(.*)@([^@]+):(\d+)$/.exec(dec);
    if (!m) throw new Error('ss link is not valid');
    [, method, password, host, port] = m; port = parseInt(port, 10);
  }
  return {
    name: name || `${host}:${port}`, protocol: 'shadowsocks',
    outbound: { type: 'shadowsocks', server: host, server_port: port, method, password }
  };
}

function parseHy2(u) {
  const p = u.params;
  const ob = { type: 'hysteria2', server: u.host, server_port: u.port || 443, password: decodeURIComponent(u.userinfo) };
  if (p.obfs && p.obfs !== 'none') ob.obfs = { type: p.obfs, password: p['obfs-password'] || p.obfs_password || '' };
  ob.tls = { enabled: true, server_name: p.sni || u.host, alpn: ['h3'] };
  if (bool(p.insecure) || bool(p.allowInsecure)) ob.tls.insecure = true;
  if (p.mport) { /* port hopping */ ob.server_ports = p.mport.split(',').map(s => s.replace('-', ':')); }
  return { name: u.name || `${u.host}:${ob.server_port}`, protocol: 'hysteria2', outbound: ob };
}

function parseTuic(u) {
  const p = u.params;
  const ui = decodeURIComponent(u.userinfo);
  const c = ui.indexOf(':');
  const ob = {
    type: 'tuic', server: u.host, server_port: u.port || 443,
    uuid: c >= 0 ? ui.slice(0, c) : ui, password: c >= 0 ? ui.slice(c + 1) : '',
    congestion_control: p.congestion_control || 'bbr', udp_relay_mode: p.udp_relay_mode || 'native'
  };
  ob.tls = { enabled: true, server_name: p.sni || u.host, alpn: (p.alpn || 'h3').split(',') };
  if (bool(p.allow_insecure) || bool(p.insecure)) ob.tls.insecure = true;
  return { name: u.name || `${u.host}:${ob.server_port}`, protocol: 'tuic', outbound: ob };
}

function parseSocksHttp(u, kind) {
  const ob = { type: kind, server: u.host, server_port: u.port || (kind === 'http' ? 8080 : 1080) };
  if (kind === 'socks') ob.version = '5';
  if (u.userinfo) {
    let ui = decodeURIComponent(u.userinfo);
    if (!ui.includes(':') && looksBase64(ui)) { try { ui = b64decode(ui); } catch {} }
    const c = ui.indexOf(':');
    ob.username = c >= 0 ? ui.slice(0, c) : ui;
    if (c >= 0) ob.password = ui.slice(c + 1);
  }
  if (kind === 'http' && u.scheme === 'https') ob.tls = { enabled: true, server_name: u.host };
  return { name: u.name || `${kind.toUpperCase()} ${u.host}:${ob.server_port}`, protocol: kind, outbound: ob };
}

// Telegram links: tg://socks, t.me/socks → SOCKS5 (works for everything). tg://proxy, t.me/proxy → MTProto (Telegram only).
function parseTelegram(link) {
  let q = '';
  const i = link.indexOf('?');
  if (i >= 0) q = link.slice(i + 1);
  const params = Object.fromEntries(new URLSearchParams(q));
  const isSocks = /\/\/(?:t\.me|telegram\.me)\/socks|^tg:\/\/socks/i.test(link);
  if (isSocks) {
    const ob = { type: 'socks', version: '5', server: params.server, server_port: parseInt(params.port, 10) || 1080 };
    if (params.user) ob.username = params.user;
    if (params.pass) ob.password = params.pass;
    return { name: `Telegram SOCKS ${params.server}`, protocol: 'socks', outbound: ob };
  }
  return {
    name: `Telegram · ${params.server}`, protocol: 'mtproto', mtproto: true,
    tgLink: `tg://proxy?server=${encodeURIComponent(params.server || '')}&port=${encodeURIComponent(params.port || '')}&secret=${encodeURIComponent(params.secret || '')}`,
    outbound: { type: 'mtproto', server: params.server, server_port: parseInt(params.port, 10) || 443 }
  };
}

function parseLink(raw) {
  const link = String(raw || '').trim();
  if (!link) throw new Error('empty');
  const lower = link.toLowerCase();
  let s;
  if (lower.startsWith('vmess://')) s = parseVmess(link);
  else if (lower.startsWith('ss://')) s = parseSS(link);
  else if (/^tg:\/\/(proxy|socks)/.test(lower) || /^https?:\/\/(t\.me|telegram\.me)\/(proxy|socks)/.test(lower)) s = parseTelegram(link);
  else {
    const u = splitUrl(link);
    if (u) {
      switch (u.scheme) {
        case 'vless': s = parseVlessTrojan(u, 'vless'); break;
        case 'trojan': s = parseVlessTrojan(u, 'trojan'); break;
        case 'hysteria2': case 'hy2': s = parseHy2(u); break;
        case 'tuic': s = parseTuic(u); break;
        case 'socks': case 'socks5': case 'socks5h': s = parseSocksHttp(u, 'socks'); break;
        case 'http': case 'https': s = parseSocksHttp(u, 'http'); break;
        default: throw new Error('unsupported link type: ' + u.scheme);
      }
    } else {
      // host:port or host:port:user:pass → SOCKS5
      const parts = link.split(':');
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
        const ob = { type: 'socks', version: '5', server: parts[0], server_port: parseInt(parts[1], 10) };
        if (parts[2]) ob.username = parts[2];
        if (parts[3]) ob.password = parts.slice(3).join(':');
        s = { name: `SOCKS ${parts[0]}:${parts[1]}`, protocol: 'socks', outbound: ob };
      } else throw new Error('unknown link');
    }
  }
  if (!s.outbound.server || !s.outbound.server_port) throw new Error('missing server or port');
  s.id = uid();
  s.raw = link;
  return s;
}

// Telegram channel posts: "السيرفر: host / البورت: 443 / المفتاح السري: dd…" (also Server/Port/Secret in English)
function parseProxyPosts(text) {
  const out = [];
  const re = /(?:السيرفر|السيرڤر|العنوان|server)\s*[:：]?\s*\n?\s*([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})[\s\S]{0,80}?(?:البورت|المنفذ|port)\s*[:：]?\s*\n?\s*(\d{2,5})[\s\S]{0,80}?(?:المفتاح السري|السر|secret)\s*[:：]?\s*\n?\s*([0-9a-z_=+/-]{16,})/gi;
  let m;
  while ((m = re.exec(text))) out.push(`tg://proxy?server=${m[1]}&port=${m[2]}&secret=${m[3]}`);
  return out;
}

// A subscription body may be base64 (one link per line after decoding) or plain links.
function parseMany(text) {
  let body = String(text || '').trim();
  if (!/:\/\//.test(body) && looksBase64(body)) {
    try { body = b64decode(body); } catch {}
  }
  const servers = [], errors = [];
  for (const l of parseProxyPosts(body)) { try { servers.push(parseLink(l)); } catch {} }
  if (servers.length && !/:\/\//.test(body.replace(/tg:\/\/proxy[^\s]*/g, ''))) return { servers, errors };
  for (const line of body.split(/[\r\n]+/)) {
    const l = line.trim();
    if (!l || l.startsWith('#') || l.startsWith('//')) continue;
    try { servers.push(parseLink(l)); } catch (e) { errors.push({ line: l.slice(0, 80), error: e.message }); }
  }
  return { servers, errors };
}

function isSubscriptionUrl(text) {
  const t = String(text || '').trim();
  if (!/^https?:\/\//i.test(t) || /\s/.test(t)) return false;
  if (/^https?:\/\/(t\.me|telegram\.me)\//i.test(t)) return false;
  const u = splitUrl(t);
  return !!(u && (u.path && u.path !== '/' || Object.keys(u.params).length || !u.port));
}

module.exports = { parseLink, parseMany, parseProxyPosts, isSubscriptionUrl, b64decode };
