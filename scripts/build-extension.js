// Copies the shared popup into each browser build and stamps the app version into the manifests.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'extension');
const version = require('../package.json').version;
for (const kind of ['chromium', 'firefox']) {
  for (const f of fs.readdirSync(path.join(root, 'shared'))) fs.copyFileSync(path.join(root, 'shared', f), path.join(root, kind, f));
  const mf = path.join(root, kind, 'manifest.json');
  const j = JSON.parse(fs.readFileSync(mf, 'utf8'));
  j.version = version;
  fs.writeFileSync(mf, JSON.stringify(j, null, 2));
}
console.log('extension built', version);
