'use strict';
// IBRA VPN — free Cloudflare WARP account (WireGuard). Registers a device with Cloudflare's public client API
// and turns the result into a sing-box wireguard endpoint.

const crypto = require('crypto');
const https = require('https');

function genKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64');
  return { pub, priv };
}

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.cloudflareclient.com', path, method, timeout: 20000,
      headers: Object.assign({
        'User-Agent': 'okhttp/3.12.1', 'CF-Client-Version': 'a-6.30-3596',
        'Content-Type': 'application/json; charset=UTF-8'
      }, data ? { 'Content-Length': Buffer.byteLength(data) } : {}, token ? { Authorization: 'Bearer ' + token } : {})
    }, res => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (res.statusCode >= 400) return reject(new Error('WARP ' + res.statusCode + ': ' + (j.errors?.[0]?.message || buf.slice(0, 120))));
          resolve(j);
        } catch { reject(new Error('WARP bad response ' + res.statusCode)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('WARP timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function reservedFromClientId(clientId) {
  try { return Array.from(Buffer.from(clientId, 'base64')).slice(0, 3); } catch { return [0, 0, 0]; }
}

async function register() {
  const { pub, priv } = genKeyPair();
  const res = await request('POST', '/v0a2158/reg', {
    key: pub, install_id: '', fcm_token: '', tos: new Date().toISOString(),
    type: 'Android', model: 'PC', locale: 'en_US', warp_enabled: true
  });
  const cfg = res.config || (res.result && res.result.config);
  if (!cfg) throw new Error('WARP: no config in response');
  const peer = cfg.peers[0];
  const v4 = cfg.interface.addresses.v4;
  const v6 = cfg.interface.addresses.v6;
  return {
    privateKey: priv,
    peerPublicKey: peer.public_key,
    v4, v6,
    reserved: reservedFromClientId(cfg.client_id),
    accountId: res.id,
    token: res.token
  };
}

// Known WARP endpoint IPs; user can pick another in settings.
const WARP_ENDPOINTS = ['162.159.192.1', '162.159.193.1', '162.159.195.1', '188.114.97.1', '188.114.96.1'];
const WARP_PORTS = [2408, 500, 1701, 4500, 854, 894];

function toServer(acc, opts = {}) {
  const host = opts.host || WARP_ENDPOINTS[0];
  const port = opts.port || 2408;
  return {
    id: 'warp',
    name: 'Cloudflare WARP (مجاني)',
    protocol: 'warp',
    builtin: true,
    endpoint: {
      type: 'wireguard',
      address: [acc.v4 + '/32', acc.v6 + '/128'],
      private_key: acc.privateKey,
      mtu: 1280,
      peers: [{
        address: host, port,
        public_key: acc.peerPublicKey,
        allowed_ips: ['0.0.0.0/0', '::/0'],
        reserved: acc.reserved,
        persistent_keepalive_interval: 25
      }]
    }
  };
}

module.exports = { register, toServer, genKeyPair, WARP_ENDPOINTS, WARP_PORTS };
