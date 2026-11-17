'use strict';
// IBRA VPN — builds a sing-box (1.12+) configuration from the selected server and settings.

const RULESET_URL = {
  'geoip-iq': 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-iq.srs',
  'geosite-category-ads-all': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ads-all.srs',
  'geosite-facebook': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-facebook.srs',
  'geosite-instagram': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-instagram.srs',
  'geosite-whatsapp': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-whatsapp.srs',
  'geosite-meta': 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-meta.srs'
};
const SOCIAL = ['geosite-facebook', 'geosite-instagram', 'geosite-whatsapp', 'geosite-meta'];

// Rule sets ship inside the app (rulesDir) so startup never depends on a download; remote is only a fallback.
function ruleSet(tag, o, detour) {
  const fs = require('fs');
  const path = require('path');
  if (o.rulesDir) {
    const f = path.join(o.rulesDir, tag + '.srs');
    if (fs.existsSync(f)) return { tag, type: 'local', format: 'binary', path: f.replace(/\\/g, '/') };
  }
  return { tag, type: 'remote', format: 'binary', url: RULESET_URL[tag], download_detour: detour };
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function remoteDns(choice, detour) {
  const map = {
    cloudflare: { type: 'https', server: '1.1.1.1' },
    google: { type: 'https', server: '8.8.8.8' },
    quad9: { type: 'https', server: '9.9.9.9' },
    adguard: { type: 'https', server: '94.140.14.14' }
  };
  const d = Object.assign({ tag: 'dns-remote' }, map[choice] || map.cloudflare);
  if (detour) d.detour = detour;
  return d;
}

/**
 * @param {object} opts
 *  server     : server object from links.js (with .outbound), or {protocol:'warp', endpoint:{...}}, or null in "bypass" engine
 *  engine     : 'server' (default) | 'bypass'  (bypass = no server: TLS fragmentation + encrypted DNS against SNI/DNS blocking)
 *  mode       : 'proxy' (system proxy) | 'tun' (whole device)
 *  routing    : 'global' | 'smart' (Iraqi IPs go direct)
 *  blockAds   : boolean
 *  dns        : 'cloudflare'|'google'|'quad9'|'adguard'
 *  socialDirect: boolean — Instagram/Facebook/WhatsApp go out with the user's real IP (protects accounts from login checks)
 *  rulesDir   : folder with bundled .srs rule sets
 *  mixedPort, apiPort, cacheDir, logLevel
 */
function buildConfig(opts) {
  const o = Object.assign({
    engine: 'server', mode: 'proxy', routing: 'global', blockAds: false, dns: 'cloudflare', socialDirect: false, rulesDir: null,
    mixedPort: 20808, apiPort: 20809, logLevel: 'warn', cacheDir: null
  }, opts || {});

  const bypass = o.engine === 'bypass';
  const cfg = {
    log: { level: o.logLevel, timestamp: true },
    dns: {
      servers: [
        remoteDns(o.dns, bypass ? null : 'proxy'),
        { tag: 'dns-local', type: 'local' }
      ],
      final: 'dns-remote',
      strategy: 'ipv4_only'
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: o.mixedPort }
    ],
    outbounds: [],
    endpoints: [],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' }
      ],
      rule_set: [],
      final: 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-local'
    },
    experimental: {
      clash_api: { external_controller: `127.0.0.1:${o.apiPort}` }
    }
  };

  if (o.cacheDir) cfg.experimental.cache_file = { enabled: true, path: o.cacheDir.replace(/\\/g, '/') + '/cache.db' };

  if (o.mode === 'tun') {
    cfg.inbounds.push({
      type: 'tun', tag: 'tun-in', interface_name: 'IBRA-VPN',
      address: ['172.19.0.1/30'], mtu: 9000, auto_route: true, strict_route: true, stack: 'mixed'
    });
  }

  if (bypass) {
    // No server: everything leaves directly, but TLS ClientHello is fragmented so SNI filters can't read it,
    // and DNS goes over HTTPS so it can't be poisoned.
    cfg.outbounds.push({ type: 'direct', tag: 'proxy' });
    cfg.route.rules.splice(1, 0, { action: 'route-options', tls_fragment: true });
  } else {
    const s = o.server;
    if (!s) throw new Error('no server selected');
    if (s.protocol === 'mtproto') throw new Error('MTPROTO_ONLY_TELEGRAM');
    if (s.protocol === 'warp') {
      const ep = clone(s.endpoint);
      ep.tag = 'proxy';
      cfg.endpoints.push(ep);
    } else {
      const ob = clone(s.outbound);
      ob.tag = 'proxy';
      cfg.outbounds.push(ob);
    }
  }
  cfg.outbounds.push({ type: 'direct', tag: 'direct' });

  const detour = bypass ? 'direct' : 'proxy';
  if (o.blockAds) {
    cfg.route.rule_set.push(ruleSet('geosite-category-ads-all', o, detour));
    cfg.route.rules.push({ rule_set: ['geosite-category-ads-all'], action: 'reject' });
  }
  if (o.socialDirect && !bypass) {
    for (const t of SOCIAL) cfg.route.rule_set.push(ruleSet(t, o, 'direct'));
    cfg.route.rules.push({ rule_set: SOCIAL, outbound: 'direct' });
    // resolve these with the local resolver so Meta gives Iraqi edge servers that match the real IP
    cfg.dns.rules = [{ rule_set: SOCIAL, server: 'dns-local' }];
  }
  if (o.routing === 'smart' && !bypass) {
    cfg.route.rule_set.push(ruleSet('geoip-iq', o, detour));
    cfg.route.rules.push({ rule_set: ['geoip-iq'], outbound: 'direct' });
  }

  if (!cfg.endpoints.length) delete cfg.endpoints;
  if (!cfg.route.rule_set.length) delete cfg.route.rule_set;
  return cfg;
}

// Minimal config used only to measure a server's real latency through the clash API (/proxies/<tag>/delay).
function buildTestConfig(server, apiPort) {
  const cfg = {
    log: { level: 'error' },
    dns: { servers: [{ tag: 'dns-local', type: 'local' }] },
    inbounds: [],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: { final: 'direct', default_domain_resolver: 'dns-local' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } }
  };
  if (server.protocol === 'warp') {
    const ep = clone(server.endpoint); ep.tag = 'test'; cfg.endpoints = [ep];
  } else {
    const ob = clone(server.outbound); ob.tag = 'test'; cfg.outbounds.unshift(ob);
  }
  return cfg;
}

// One process that holds every server as outbound "t0..tN", so all of them can be delay-tested in parallel.
function buildMultiTestConfig(servers, apiPort) {
  const cfg = {
    log: { level: 'error' },
    dns: { servers: [{ tag: 'dns-local', type: 'local' }] },
    inbounds: [],
    outbounds: [],
    endpoints: [],
    route: { final: 'direct', default_domain_resolver: 'dns-local' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${apiPort}` } }
  };
  servers.forEach((s, i) => {
    if (s.protocol === 'mtproto') return;
    if (s.protocol === 'warp') { const ep = clone(s.endpoint); ep.tag = 't' + i; cfg.endpoints.push(ep); }
    else { const ob = clone(s.outbound); ob.tag = 't' + i; cfg.outbounds.push(ob); }
  });
  cfg.outbounds.push({ type: 'direct', tag: 'direct' });
  if (!cfg.endpoints.length) delete cfg.endpoints;
  return cfg;
}

module.exports = { RULESET_URL, buildConfig, buildTestConfig, buildMultiTestConfig };
