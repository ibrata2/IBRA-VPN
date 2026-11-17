'use strict';
// IBRA VPN — Windows system proxy (WinINet) on/off, with an immediate refresh so browsers pick it up at once.

const { execFile } = require('child_process');

const BYPASS = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.30.*;172.31.*;192.168.*;<local>';

const REFRESH = `
$sig = @'
[DllImport("wininet.dll", SetLastError = true)]
public static extern bool InternetSetOption(System.IntPtr hInternet, int dwOption, System.IntPtr lpBuffer, int dwBufferLength);
'@
$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace IbraVpn -PassThru
[void]$t::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0)
[void]$t::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0)
`;

const KEY = "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'";

function ps(script) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()));
        resolve(stdout.trim());
      });
  });
}

async function enable(port) {
  const server = `127.0.0.1:${port}`;
  await ps(`
Set-ItemProperty -Path ${KEY} -Name ProxyEnable -Value 1
Set-ItemProperty -Path ${KEY} -Name ProxyServer -Value '${server}'
Set-ItemProperty -Path ${KEY} -Name ProxyOverride -Value '${BYPASS}'
${REFRESH}`);
}

async function disable(onlyIfPort) {
  const guard = onlyIfPort
    ? `$cur = (Get-ItemProperty -Path ${KEY} -ErrorAction SilentlyContinue).ProxyServer
if ($cur -ne '127.0.0.1:${onlyIfPort}') { exit 0 }`
    : '';
  await ps(`${guard}
Set-ItemProperty -Path ${KEY} -Name ProxyEnable -Value 0
${REFRESH}`);
}

module.exports = { enable, disable };
