// machine.js — a few facts about the computer NodeCut is running on, for the sidebar.
//
// Deliberately small and cheap: everything here is read ONCE at startup and cached, because none of it changes
// while the hub is up (CPU model, GPU, OS). The two figures that DO change — free RAM and free disk — are read on
// demand by the caller, not cached here.
//
// The GPU is the only platform-specific part. Every platform has a different way to ask, and every one of those
// commands can be missing or slow, so each lookup is timeboxed and a failure returns null rather than throwing:
// a sidebar line is not worth a crashed server.

import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const run = (file, args, timeout = 1500) => {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out && out.trim() ? out : null;
  } catch { return null; }
};

// ---- GPU: the one thing Node has no API for ----------------------------------------------------------------
let gpuCache;
function gpu() {
  if (gpuCache !== undefined) return gpuCache;
  gpuCache = null;
  try {
    if (process.platform === 'darwin') {
      // "Chipset Model: Apple M2 Pro", once per display; the first is the driving GPU
      const out = run('system_profiler', ['SPDisplaysDataType']);
      const m = out && out.match(/Chipset Model:\s*(.+)/);
      if (m) gpuCache = m[1].trim();
    } else if (process.platform === 'win32') {
      // WMI is present on every supported Windows; Name is the friendly name ("NVIDIA GeForce RTX 3060")
      const out = run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name']);
      const first = out && out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first) gpuCache = first;
    } else {
      // Linux: the card's driver name via lspci is the most reliable signal; fall back to the DRM driver name
      const out = run('sh', ['-c', "lspci 2>/dev/null | grep -iE 'vga|3d controller' | head -n1 | sed 's/.*: //'"]);
      if (out && out.trim()) gpuCache = out.trim();
      else {
        const drm = run('sh', ['-c', "cat /sys/class/drm/card0/device/uevent 2>/dev/null | grep -i '^DRIVER=' | cut -d= -f2"]);
        if (drm && drm.trim()) gpuCache = drm.trim() + ' (DRM)';
      }
    }
  } catch { gpuCache = null; }
  return gpuCache;
}

// ---- OS: a friendly name, not a kernel string --------------------------------------------------------------
function osName() {
  if (process.platform === 'darwin') {
    const v = run('sw_vers', ['-productVersion']);
    const m = v && v.match(/([\d.]+)/);
    return 'macOS' + (m ? ' ' + m[1].split('.')[0] : '');
  }
  if (process.platform === 'win32') return 'Windows';
  const rel = run('sh', ['-c', "cat /etc/os-release 2>/dev/null | grep ^PRETTY_NAME | cut -d= -f2-"]);
  return rel ? rel.trim().replace(/^"|"$/g, '') : 'Linux';
}

function cpuInfo() {
  const list = os.cpus() || [];
  const model = list[0]?.model || '';
  // "Intel(R) Core(TM) i7-8700B CPU @ 3.20GHz" -> "Intel Core i7-8700B": the marks and the clock are noise here
  const short = model.replace(/\(R\)|\(TM\)|\(tm\)/g, '').replace(/\s*CPU\b/g, '').replace(/@.*$/, '').replace(/\s+/g, ' ').trim();
  return { model: short || model || 'unknown', cores: list.length };
}

let cache;
/** Everything static about this machine, computed once per process. */
export function machine() {
  if (cache) return cache;
  const { model, cores } = cpuInfo();
  cache = {
    os: osName(),
    arch: os.arch(),
    cpu: model,
    cores,
    ramTotalGB: Math.round(os.totalmem() / 1073741824),
    gpu: gpu(),
  };
  return cache;
}

/** Free and total disk space, in GB, for the volume holding `atPath`. Not cached: this changes. */
export function diskSpace(atPath) {
  try {
    const s = fs.statfsSync(atPath || os.homedir());
    return { freeGB: Math.round((s.bavail * s.bsize) / 1e9), totalGB: Math.round((s.blocks * s.bsize) / 1e9) };
  } catch { return null; }
}
