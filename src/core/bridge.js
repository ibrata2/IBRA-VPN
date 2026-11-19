'use strict';
// IBRA VPN — local control API for the browser extension (127.0.0.1 only).
// Only browser extensions (and local tools without an Origin) may call it — never websites.

const http = require('http');

const PORTS = [20790, 20791, 20792, 20793, 20794];
let lastContact = 0; // when a browser extension last called the app (to confirm an automatic install)
const contacts = {}; // origin -> time

function start({ getStatus, connect, disconnect, log }) {
  const handler = async (req, res) => {
    const origin = req.headers.origin || '';
    if (origin && !/^(chrome|moz|ms-browser|safari-web)-extension:\/\//i.test(origin)) {
      res.writeHead(403); return res.end();
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (origin) {
      lastContact = Date.now(); contacts[origin] = lastContact;
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
    const url = (req.url || '/').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/status') {
        res.writeHead(200, headers); return res.end(JSON.stringify(getStatus()));
      }
      if (req.method === 'POST' && url === '/connect') {
        await connect('extension');
        res.writeHead(200, headers); return res.end(JSON.stringify(getStatus()));
      }
      if (req.method === 'POST' && url === '/disconnect') {
        await disconnect();
        res.writeHead(200, headers); return res.end(JSON.stringify(getStatus()));
      }
      res.writeHead(404, headers); res.end('{}');
    } catch (e) {
      res.writeHead(500, headers); res.end(JSON.stringify({ error: e.message }));
    }
  };

  let i = 0;
  const tryListen = () => {
    if (i >= PORTS.length) { log && log('browser bridge: no free port'); return; }
    const port = PORTS[i++];
    const server = http.createServer(handler);
    server.once('error', tryListen);
    server.listen(port, '127.0.0.1', () => log && log('browser bridge on 127.0.0.1:' + port));
  };
  tryListen();
}

module.exports = { start, PORTS, lastContact: () => lastContact, contacts: () => ({ ...contacts }) };
