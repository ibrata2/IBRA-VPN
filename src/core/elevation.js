'use strict';
// IBRA VPN — "always run as administrator" without a UAC prompt on every launch.
// Once (with one UAC approval) we register a Task Scheduler task that runs the app with highest privileges.
// After that, a normal launch just starts that task and exits, so the app comes back elevated silently.

const { execFile } = require('child_process');

const TASK = 'IBRA VPN Admin';

function ps(script, timeout = 30000) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, out: 'not windows' });
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || (err && err.message) || '').trim() }));
  });
}

const q = s => String(s).replace(/'/g, "''");

/** Needs to run elevated. */
async function registerTask(exe) {
  const script = `
$a = New-ScheduledTaskAction -Execute '${q(exe)}' -Argument '--elevated'
$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${q(TASK)}' -Action $a -Principal $p -Settings $s -Force | Out-Null
'ok'`;
  const r = await ps(script);
  return r.ok && r.out.includes('ok');
}

async function removeTask() {
  const r = await ps(`Unregister-ScheduledTask -TaskName '${q(TASK)}' -Confirm:$false -ErrorAction SilentlyContinue; 'ok'`);
  return r.ok;
}

async function taskExists() {
  const r = await ps(`if (Get-ScheduledTask -TaskName '${q(TASK)}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  return r.out.includes('yes');
}

function runTask() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false);
    execFile('schtasks.exe', ['/run', '/tn', TASK], { windowsHide: true, timeout: 15000 }, err => resolve(!err));
  });
}

module.exports = { registerTask, removeTask, taskExists, runTask, TASK };
