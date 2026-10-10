// OS system logs, read with the tools the OS provides and the access this user already has.
// Windows: Event Viewer (Get-WinEvent) · macOS: unified log (log show) · Linux: systemd journal (journalctl).
import { execFile } from 'node:child_process';

const run = (cmd, args) => new Promise((ok, fail) =>
  execFile(cmd, args, { timeout: 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, out, stderr) =>
    err ? fail(new Error((stderr || err.message).toString().trim().split('\n')[0])) : ok(out)));

const WIN_LEVEL = { 1: 'fatal', 2: 'error', 3: 'warn', 4: 'info', 5: 'debug', 0: 'info' };
const JOURNAL_LEVEL = ['fatal', 'fatal', 'fatal', 'error', 'warn', 'info', 'info', 'debug'];

export const osLogLabel = () => ({ win32: 'Windows Event Viewer', darwin: 'macOS unified log', linux: 'systemd journal' })[process.platform] || 'OS log';

// Returns [{ ts, level, msg, meta }] newer than `since` (ms epoch).
export async function readOsLogs({ since, channel, max = 200 }) {
  if (process.platform === 'win32') {
    const log = /^[\w ./-]{1,80}$/.test(channel || '') ? channel : 'Application';
    const start = new Date(since).toISOString();
    const ps = `$ErrorActionPreference="Stop"; Get-WinEvent -FilterHashtable @{LogName='${log}'; StartTime=[datetime]::Parse('${start}').ToLocalTime()} -MaxEvents ${max} -ErrorAction SilentlyContinue | Select-Object @{n='ts';e={[DateTimeOffset]::new($_.TimeCreated).ToUnixTimeMilliseconds()}},Level,Id,ProviderName,ProcessId,Message | ConvertTo-Json -Compress`;
    const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])).trim();
    return [].concat(out ? JSON.parse(out) : []).map(e => ({
      ts: +e.ts, level: WIN_LEVEL[e.Level] || 'info', msg: String(e.Message || '').trim() || `(event ${e.Id})`,
      meta: { provider: e.ProviderName, eventId: e.Id, pid: e.ProcessId, channel: log },
    }));
  }
  if (process.platform === 'darwin') {
    const start = new Date(since).toISOString().replace('T', ' ').slice(0, 19);
    const pred = channel ? ['--predicate', channel] : ['--predicate', 'messageType == error OR messageType == fault'];
    const out = await run('log', ['show', '--style', 'ndjson', '--start', start, ...pred]);
    return out.split('\n').filter(l => l.startsWith('{')).slice(-max).map(l => {
      const e = JSON.parse(l);
      return { ts: Date.parse(e.timestamp), level: { fault: 'fatal', error: 'error', default: 'info', info: 'info', debug: 'debug' }[e.messageType] || 'info',
        msg: e.eventMessage, meta: { process: e.processImagePath?.split('/').pop(), pid: e.processID, subsystem: e.subsystem } };
    });
  }
  const args = ['-o', 'json', '--no-pager', '--since', `@${Math.floor(since / 1000)}`, '-n', String(max)];
  if (channel) args.push('-u', channel);
  const out = await run('journalctl', args);
  return out.split('\n').filter(l => l.startsWith('{')).map(l => {
    const e = JSON.parse(l);
    return { ts: Math.round(+e.__REALTIME_TIMESTAMP / 1000), level: JOURNAL_LEVEL[+e.PRIORITY] || 'info',
      msg: Array.isArray(e.MESSAGE) ? '(binary message)' : String(e.MESSAGE ?? ''), meta: { unit: e._SYSTEMD_UNIT, process: e._COMM, pid: +e._PID || undefined } };
  });
}
