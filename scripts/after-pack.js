// Sets the IBRA VPN icon and version info on the packaged exe (works on Linux/macOS without wine).
'use strict';
const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
  const pkg = context.packager.appInfo;
  const data = fs.readFileSync(exe);
  const ne = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(ne);

  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map(i => i.data));

  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  if (vi) {
    const [a, b, c] = pkg.version.split('.').map(n => parseInt(n, 10) || 0);
    vi.setFileVersion(a, b, c, 0, 1033);
    vi.setProductVersion(a, b, c, 0, 1033);
    vi.setStringValues({ lang: 1033, codepage: 1200 }, {
      ProductName: 'IBRA VPN', FileDescription: 'IBRA VPN', CompanyName: 'IBRAPROGRAM',
      LegalCopyright: 'Ibrahim Al-Khazraji', OriginalFilename: 'IBRA VPN.exe', InternalName: 'IBRA VPN',
      FileVersion: pkg.version, ProductVersion: pkg.version
    });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(ne);
  fs.writeFileSync(exe, Buffer.from(ne.generate()));
  console.log('  • icon + version info set on', path.basename(exe));
};
