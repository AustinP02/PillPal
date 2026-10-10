// OS process listing for Debug Station. Uses only what the OS already lets this user see:
// Windows → CIM via PowerShell, macOS/Linux → ps. Nothing is elevated, nothing is bypassed.
import { execFile } from 'node:child_process';
import os from 'node:os';

const run = (cmd, args, timeout = 15000) => new Promise((ok, fail) =>
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    err ? fail(Object.assign(err, { stderr })) : ok(stdout)));

const CORES = os.availableParallelism?.() || os.cpus().length || 1;
let prev = new Map(), prevAt = 0; // Windows: CPU % comes from the change in CPU time between two samples

function psDate(v) {
  if (!v) return null;
  const m = /Date\((\d+)/.exec(v); // Windows PowerShell 5.1 serializes DateTime as "\/Date(ms)\/"
  const n = m ? +m[1] : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

async function listWindows() {
  const ps = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime,ThreadCount | ConvertTo-Json -Compress';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  const now = Date.now(), dt = prevAt ? now - prevAt : 0;
  const rows = [].concat(JSON.parse(out || '[]'));
  const next = new Map();
  const list = rows.map(r => {
    const cpuMs = ((+r.KernelModeTime || 0) + (+r.UserModeTime || 0)) / 1e4;
    next.set(r.ProcessId, cpuMs);
    const before = prev.get(r.ProcessId);
    const inaccessible = r.CommandLine == null && r.ExecutablePath == null && r.ProcessId > 4;
    return {
      pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name || '?',
      cpu: dt && before != null ? Math.max(0, +(((cpuMs - before) / dt) * 100 / CORES).toFixed(1)) : null,
      mem: +r.WorkingSetSize || 0, threads: r.ThreadCount, started: psDate(r.CreationDate),
      cmd: r.CommandLine || null, path: r.ExecutablePath || null,
      status: inaccessible ? 'inaccessible' : 'running',
    };
  });
  prev = next; prevAt = now;
  return list;
}

// etime: [[dd-]hh:]mm:ss
const etimeMs = e => {
  const [d, rest] = e.includes('-') ? e.split('-') : [0, e];
  const p = rest.split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return (((+d * 24 + p[0]) * 60 + p[1]) * 60 + p[2]) * 1000;
};
const STAT = s => s.startsWith('Z') ? 'crashed' : s.startsWith('T') ? 'stopped' : 'running';

async function listUnix() {
  const me = os.userInfo().username;
  const out = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,stat=,etime=,user=,args=']);
  const now = Date.now();
  return out.split('\n').filter(Boolean).map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) return null;
    const [, pid, ppid, cpu, rss, stat, etime, user, args] = m;
    const own = user === me;
    return {
      pid: +pid, ppid: +ppid, name: (args.split(' ')[0].split('/').pop() || '?').replace(/^\[|\]$/g, ''),
      cpu: +cpu, mem: +rss * 1024, started: now - etimeMs(etime), user,
      cmd: own ? args : null, status: STAT(stat) === 'running' && !own ? 'inaccessible' : STAT(stat), rawStat: stat,
    };
  }).filter(Boolean);
}

export async function listProcesses() {
  return process.platform === 'win32' ? listWindows() : listUnix();
}

// Cheap per-PID stats for the metrics chart (mongod etc.).
export async function statPids(pids) {
  pids = pids.filter(Boolean);
  if (!pids.length) return {};
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference="SilentlyContinue"; Get-Process -Id ${pids.join(',')} | Select-Object Id,CPU,WorkingSet64 | ConvertTo-Json -Compress`]);
    const now = Date.now(), res = {};
    for (const r of [].concat(JSON.parse(out || '[]'))) {
      const key = 'stat' + r.Id, before = statPrev.get(key), cpuMs = (+r.CPU || 0) * 1000;
      res[r.Id] = { cpu: before ? Math.max(0, +(((cpuMs - before.cpuMs) / (now - before.at)) * 100 / CORES).toFixed(1)) : null, mem: +r.WorkingSet64 || 0 };
      statPrev.set(key, { cpuMs, at: now });
    }
    return res;
  }
  const out = await run('ps', ['-o', 'pid=,pcpu=,rss=', '-p', pids.join(',')]).catch(() => '');
  return Object.fromEntries(out.split('\n').filter(Boolean).map(l => l.trim().split(/\s+/)).map(([p, c, r]) => [p, { cpu: +c, mem: +r * 1024 }]));
}
const statPrev = new Map();
