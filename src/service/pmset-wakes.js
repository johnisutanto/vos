// Scheduled Mac wakes a few minutes before each vos slot, so a sleeping
// machine is up when node-cron fires.
//
// Why one-shot `pmset schedule` instead of `pmset repeat`:
//   macOS allows only one repeating wake. This machine (and any other) may
//   already have one — we must not overwrite it. One-shot events tagged with
//   OWNER can coexist, and we only cancel events we created.
//
// Why a root LaunchDaemon:
//   `pmset schedule` requires root. The user agent cannot replenish wakes
//   without an admin prompt every time. Installing the daemon is one prompt
//   (osascript from the UI, sudo from a terminal). After that the daemon
//   refreshes the rolling window as root, using the node binary and repo path
//   captured on *this* machine at install time — so the same code works on
//   any Mac, with any home directory, nvm, or Homebrew node.
//
// We never call `pmset repeat cancel` or `pmset schedule cancelall`.

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../config.js';
import { planWakes, formatPmsetDate, formatLocalTime } from './cron-slots.js';

const execFileAsync = promisify(execFile);

export const OWNER = 'local.vos';
export const DAEMON_LABEL = 'local.vos.wake';
export const EVENT_TYPE = 'wakeorpoweron';
export const HORIZON_DAYS = 14;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = join(ROOT, 'src', 'index.js');
const DAEMON_PLIST = `/Library/LaunchDaemons/${DAEMON_LABEL}.plist`;
const LEDGER_PATH = join(ROOT, 'logs', 'pmset-wakes.json');

export const paths = { daemonPlist: DAEMON_PLIST, ledger: LEDGER_PATH, root: ROOT };

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function buildDaemonPlist() {
  // Capture this machine's node and checkout. A plist copied from another Mac
  // would point at the wrong paths — always `vos service install` on the Mac
  // that will run it.
  const args = [process.execPath, ENTRY, 'service', 'wakes'];
  const logDir = join(ROOT, 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(DAEMON_LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join('\n')}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xmlEscape(ROOT)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t\t<key>HOME</key>
\t\t<string>${xmlEscape(homedir())}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>StartInterval</key>
\t<integer>3600</integer>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(join(logDir, 'wakes.out.log'))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(join(logDir, 'wakes.err.log'))}</string>
</dict>
</plist>
`;
}

async function runPrivileged(scriptBody) {
  if (process.platform !== 'darwin') {
    throw new Error('Scheduled wakes require macOS (pmset).');
  }
  if (isRoot()) {
    const r = spawnSync('/bin/bash', ['-e', '-c', scriptBody], { encoding: 'utf8' });
    if (r.status !== 0) {
      throw new Error((r.stderr || r.stdout || `exit ${r.status}`).trim());
    }
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'vos-priv-'));
  const sh = join(dir, 'run.sh');
  await writeFile(sh, `#!/bin/bash\nset -euo pipefail\n${scriptBody}\n`, { mode: 0o700 });
  try {
    const nopass = spawnSync('sudo', ['-n', '/bin/bash', sh], { encoding: 'utf8' });
    if (nopass.status === 0) return;

    if (process.stdin.isTTY && process.stdout.isTTY) {
      const interactive = spawnSync('sudo', ['/bin/bash', sh], { stdio: 'inherit' });
      if (interactive.status !== 0) {
        throw new Error('Administrator authorization failed (sudo).');
      }
      return;
    }

    // GUI prompt — this is what the admin-site toggle uses. Works on any Mac
    // with a logged-in console user; no passwordless sudo required.
    const osa = spawnSync('osascript', [
      '-e',
      `do shell script "/bin/bash " & quoted form of ${JSON.stringify(sh)} with administrator privileges`,
    ], { encoding: 'utf8' });
    if (osa.status !== 0) {
      const err = (osa.stderr || osa.stdout || '').trim();
      if (/[-]128|user canceled|cancelled/i.test(err)) {
        throw new Error('Administrator authorization was cancelled. Scheduled wakes were not installed.');
      }
      throw new Error(err || 'Administrator authorization failed.');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function parsePmsetSched(text) {
  const events = [];
  const re = /\[\d+\]\s+(\w+)\s+at\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})\s+by\s+'([^']+)'/g;
  let m;
  while ((m = re.exec(text))) {
    const [, type, date, time, owner] = m;
    const [mo, d, y] = date.split('/');
    const yy = y.slice(-2);
    events.push({
      type,
      owner,
      key: `${mo}/${d}/${yy} ${time}`,
      display: `${date} ${time}`,
    });
  }
  return events;
}

export async function listOurScheduledEvents() {
  try {
    const { stdout } = await execFileAsync('pmset', ['-g', 'sched']);
    return parsePmsetSched(stdout).filter((e) => e.owner === OWNER);
  } catch {
    return [];
  }
}

async function readLedger() {
  try {
    const raw = JSON.parse(await readFile(LEDGER_PATH, 'utf8'));
    return Array.isArray(raw.keys) ? raw.keys : [];
  } catch {
    return [];
  }
}

async function writeLedger(keys) {
  await mkdir(dirname(LEDGER_PATH), { recursive: true });
  await writeFile(LEDGER_PATH, JSON.stringify({
    owner: OWNER,
    updatedAt: new Date().toISOString(),
    keys,
  }, null, 2));
}

function leadMinutesFrom(cfg) {
  const n = Number(cfg.options?.wakeLeadMinutes);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export async function planned(cfg) {
  const loaded = cfg || await loadConfig();
  return planWakes(loaded.schedule, {
    leadMinutes: leadMinutesFrom(loaded),
    days: HORIZON_DAYS,
  });
}

// Called as root by the LaunchDaemon (and by the privileged install script).
export async function refreshWakes(cfg) {
  if (!isRoot()) {
    throw new Error('Refreshing scheduled wakes must run as root.');
  }
  const plan = await planned(cfg);
  for (const entry of plan.skipped) {
    console.warn(`[vos] skipping wake for ${entry.app || '?'} (cron "${entry.cron}" is not a simple daily time)`);
  }
  const desired = new Set(plan.events.map((e) => e.key));
  const existing = new Set((await listOurScheduledEvents()).map((e) => e.key));

  for (const key of desired) {
    if (existing.has(key)) continue;
    const r = spawnSync('pmset', ['schedule', EVENT_TYPE, key, OWNER], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error(`[vos] pmset schedule failed for ${key}: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  for (const ev of await listOurScheduledEvents()) {
    if (desired.has(ev.key)) continue;
    spawnSync('pmset', ['schedule', 'cancel', ev.type, ev.key, OWNER], { encoding: 'utf8' });
  }
  await writeLedger([...desired]);
  console.log(`[vos] scheduled ${desired.size} wake(s) through ${formatPmsetDate(plan.until)} (${plan.leadMinutes} min lead)`);
  return plan;
}

export async function cancelOurWakes() {
  if (!isRoot()) {
    throw new Error('Cancelling scheduled wakes must run as root.');
  }
  const listed = await listOurScheduledEvents();
  const ledger = await readLedger();
  const seen = new Set();
  for (const ev of listed) {
    spawnSync('pmset', ['schedule', 'cancel', ev.type, ev.key, OWNER], { encoding: 'utf8' });
    seen.add(ev.key);
  }
  for (const key of ledger) {
    if (seen.has(key)) continue;
    spawnSync('pmset', ['schedule', 'cancel', EVENT_TYPE, key, OWNER], { encoding: 'utf8' });
  }
  await writeLedger([]);
}

export async function wakesStatus(cfg) {
  const plan = await planned(cfg);
  const ours = await listOurScheduledEvents();
  const installed = existsSync(DAEMON_PLIST);
  const next = ours[0] || (plan.events[0] ? { display: plan.events[0].wake.toLocaleString() } : null);
  return {
    installed,
    count: ours.length,
    leadMinutes: plan.leadMinutes,
    next: ours[0]?.display || (plan.events[0] ? `${formatPmsetDate(plan.events[0].wake)}` : null),
    nextSlot: plan.events[0] ? formatLocalTime(plan.events[0].slot) : null,
    through: plan.events.length ? formatPmsetDate(plan.until) : null,
    skipped: plan.skipped.map((e) => e.cron),
    daemonPlist: DAEMON_PLIST,
    owner: OWNER,
  };
}

export async function installWakeDaemon(cfg) {
  if (process.platform !== 'darwin') {
    throw new Error('Scheduled wakes require macOS (pmset).');
  }
  const loaded = cfg || await loadConfig();
  if (!loaded.schedule?.length) {
    return wakesStatus(loaded);
  }
  const plan = await planned(loaded);
  if (plan.skipped.length === loaded.schedule.length) {
    throw new Error('No schedule entries could be turned into wake times. Use "minute hour * * dow" cron (e.g. "0 8 * * *").');
  }
  await mkdir(join(ROOT, 'logs'), { recursive: true });
  const tmpPlist = join(await mkdtemp(join(tmpdir(), 'vos-wake-')), `${DAEMON_LABEL}.plist`);
  await writeFile(tmpPlist, buildDaemonPlist());
  const node = shQuote(process.execPath);
  const entry = shQuote(ENTRY);
  const script = `
cp ${shQuote(tmpPlist)} ${shQuote(DAEMON_PLIST)}
chown root:wheel ${shQuote(DAEMON_PLIST)}
chmod 644 ${shQuote(DAEMON_PLIST)}
launchctl bootout system/${DAEMON_LABEL} >/dev/null 2>&1 || true
launchctl bootstrap system ${shQuote(DAEMON_PLIST)}
# Apply the rolling window now so we do not wait for StartInterval.
${node} ${entry} service wakes
`;
  try {
    await runPrivileged(script);
  } finally {
    await rm(dirname(tmpPlist), { recursive: true, force: true });
  }
  return wakesStatus(loaded);
}

export async function uninstallWakeDaemon() {
  if (process.platform !== 'darwin') return;
  const node = shQuote(process.execPath);
  const entry = shQuote(ENTRY);
  const script = `
launchctl bootout system/${DAEMON_LABEL} >/dev/null 2>&1 || true
rm -f ${shQuote(DAEMON_PLIST)}
${node} ${entry} service wakes-cancel
`;
  await runPrivileged(script);
}
