// Print a self-contained report of why scheduled wakes may not be firing.
// Safe to run as the normal user — nothing here requires sudo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LABEL, paths as agentPaths } from './launchd.js';
import { OWNER, paths as wakePaths, listOurScheduledEvents, wakesStatus } from './pmset-wakes.js';

const execFileAsync = promisify(execFile);

async function cmd(bin, args) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout: 8000 });
    return (stdout || stderr || '').trim();
  } catch (err) {
    return (err.stdout || err.stderr || err.message || '').trim();
  }
}

function tail(file, lines = 12) {
  if (!existsSync(file)) return `(missing) ${file}`;
  const text = readFileSync(file, 'utf8').trimEnd();
  if (!text) return `(empty) ${file}`;
  return text.split('\n').slice(-lines).join('\n');
}

function pickPmset(text, keys) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\S+)\s+(.*)$/);
    if (m && keys.includes(m[1])) out[m[1]] = m[2].trim();
  }
  return out;
}

export async function diagnose(cfg) {
  const lines = [];
  const say = (s = '') => lines.push(s);

  say('vos service diagnose');
  say('====================');
  say(`now:        ${new Date().toString()}`);
  say(`platform:   ${process.platform} ${process.arch}`);
  say(`node:       ${process.execPath}`);
  say(`checkout:   ${agentPaths.root}`);
  say('');

  if (process.arch === 'arm64') {
    say('LID-CLOSED SLEEP (Apple Silicon)');
    say('  Closing the lid is NOT idle sleep. The lid magnet forces sleep, and');
    say('  macOS typically IGNORES pmset scheduled wakes until the lid is opened.');
    say('  caffeinate cannot override this. What actually works:');
    say('    1. Leave the lid open (lock the screen instead), or');
    say('    2. Clamshell: power adapter + external display (or HDMI dummy plug),');
    say('       then close the lid — the Mac stays in closed-display mode and');
    say('       scheduled wakes can fire.');
    say('  After you open the lid, vos now catch-up-pushes the slot that should');
    say('  currently be on the board.');
    say('');
  }

  const statusOut = await cmd('launchctl', ['list', LABEL]);
  const agentPlist = agentPaths.plist;
  say('USER AGENT (vos serve)');
  say(`  plist:     ${agentPlist} ${existsSync(agentPlist) ? 'present' : 'MISSING'}`);
  say(`  launchctl: ${statusOut.split('\n')[0] || statusOut || 'not loaded'}`);
  say('');

  const daemonPlist = wakePaths.daemonPlist;
  say('WAKE DAEMON (root, refreshes pmset events)');
  say(`  plist:     ${daemonPlist} ${existsSync(daemonPlist) ? 'present' : 'MISSING — enable the service and approve the admin prompt'}`);
  say('');

  const wakes = await wakesStatus(cfg);
  const ours = await listOurScheduledEvents();
  say('PMSET ONE-SHOT WAKES');
  say(`  owner:     ${OWNER}`);
  say(`  daemon:    ${wakes.installed ? 'installed' : 'NOT installed'}`);
  say(`  count:     ${ours.length} (want a rolling ~2 weeks; 0 means wakes never applied)`);
  say(`  lead:      ${wakes.leadMinutes} min before each slot`);
  say(`  next:      ${wakes.next || '(none)'}`);
  if (ours.length) {
    say('  upcoming:');
    for (const ev of ours.slice(0, 6)) say(`    ${ev.display}  type=${ev.type}`);
    if (ours.length > 6) say(`    … ${ours.length - 6} more`);
  }
  say('');

  const pmset = await cmd('pmset', ['-g']);
  const interesting = pickPmset(pmset, [
    'sleep', 'displaysleep', 'hibernatemode', 'standby', 'powernap',
    'lidwake', 'SleepDisabled', 'disablesleep', 'womp', 'networkoversleep',
    'lowpowermode', 'ttyskeepawake',
  ]);
  say('POWER SETTINGS (pmset -g)');
  for (const [k, v] of Object.entries(interesting)) say(`  ${k}: ${v}`);
  if (!Object.keys(interesting).length) say(pmset.split('\n').slice(0, 16).map((l) => `  ${l}`).join('\n'));
  say('');

  say('ALL SCHEDULED POWER EVENTS (pmset -g sched)');
  const sched = await cmd('pmset', ['-g', 'sched']);
  say(sched ? sched.split('\n').map((l) => `  ${l}`).join('\n') : '  (none)');
  say('');

  const logDir = agentPaths.logDir;
  say('RECENT LOGS');
  say(`--- ${join(logDir, 'service.out.log')} ---`);
  say(tail(join(logDir, 'service.out.log')));
  say(`--- ${join(logDir, 'service.err.log')} ---`);
  say(tail(join(logDir, 'service.err.log'), 8));
  say(`--- ${join(logDir, 'wakes.out.log')} ---`);
  say(tail(join(logDir, 'wakes.out.log')));
  say(`--- ${join(logDir, 'wakes.err.log')} ---`);
  say(tail(join(logDir, 'wakes.err.log'), 8));
  say('');

  say('SLEEP/WAKE LOG (last ~20 pmset lines; "Wake from" / "DarkWake" / "Sleep")');
  const log = await cmd('pmset', ['-g', 'log']);
  const hits = log.split('\n').filter((l) => /\b(DarkWake|FullWake|Entering Sleep|Wake from|Wake due to|Clamshell Sleep)\b/.test(l)).slice(-20);
  say(hits.length ? hits.map((l) => `  ${l}`).join('\n') : '  (could not read pmset log)');
  say('');

  say('HOW TO READ THIS');
  say('  • count 0 + daemon MISSING: the admin prompt was cancelled or install');
  say(`    was never run on this Mac. Re-run: node src/index.js service install`);
  say('  • count > 0 but lid closed still sleeps: expected on Apple Silicon.');
  say('    Use clamshell (power + display) or leave the lid open.');
  say('  • DarkWake without FullWake: the Mac blinked awake for maintenance');
  say('    and went back to sleep; the user-session scheduler stays frozen.');
  say(`  • After opening the lid, check ${join(logDir, 'service.out.log')} for`);
  say('    "[scheduler] catch-up pushed …" — that means the thaw path worked.');

  return lines.join('\n');
}
