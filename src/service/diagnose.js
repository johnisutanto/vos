// Print a self-contained report of why scheduled wakes may not be firing.
// Safe to run as the normal user — nothing here requires sudo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { paths as agentPaths, status as agentStatus } from './launchd.js';
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

  const agent = await agentStatus();
  const agentPlist = agentPaths.plist;
  const plistBody = existsSync(agentPlist) ? readFileSync(agentPlist, 'utf8') : '';
  const caffeinated = /caffeinate/.test(plistBody);
  say('USER AGENT (vos serve)');
  say(`  plist:     ${agentPlist} ${existsSync(agentPlist) ? 'present' : 'MISSING'}`);
  say(`  running:   ${agent.running ? `yes (pid ${agent.pid})` : 'NO'}`);
  say(`  caffeinate:${caffeinated ? ' yes (-i -s; blocks idle sleep on AC)' : ' NO — idle sleep will freeze the scheduler. Run: node src/index.js service restart'}`);
  say('');

  const daemonPlist = wakePaths.daemonPlist;
  say('WAKE DAEMON (root, refreshes pmset events)');
  say(`  plist:     ${daemonPlist} ${existsSync(daemonPlist) ? 'present' : 'MISSING — enable the service and approve the admin prompt'}`);
  say('');

  const wakes = await wakesStatus(cfg);
  const ours = await listOurScheduledEvents();
  const dupes = ours.length - new Set(ours.map((e) => e.key)).size;
  say('PMSET ONE-SHOT WAKES');
  say(`  owner:     ${OWNER}`);
  say(`  daemon:    ${wakes.installed ? 'installed' : 'NOT installed'}`);
  say(`  count:     ${ours.length} unique-ish (${dupes} duplicate${dupes === 1 ? '' : 's'}; rolling ~2 weeks)`);
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
  const sleepMins = String(interesting.sleep || '').match(/^(\d+)/);
  if (sleepMins && Number(sleepMins[1]) > 0 && !caffeinated) {
    say(`  ** idle sleep is ${sleepMins[1]} min. Lid open does not matter — the Mac`);
    say('     still sleeps, DarkWakes ~45s, and vos (a user-session job) stays frozen.');
    say('     After git pull, run: node src/index.js service restart');
  }
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
  say('  • count 0 + daemon MISSING: run node src/index.js service install');
  say('  • sleep: 1 (or any idle timer) + no caffeinate in the plist: the Mac');
  say('    idle-sleeps with the lid OPEN. That is this failure mode. Fix:');
  say('    git pull && node src/index.js service restart');
  say('  • DarkWake without FullWake: maintenance blink; scheduler stays frozen.');
  say('    caffeinate -i -s in the user agent prevents idle sleep on AC power.');
  say('  • Lid closed on Apple Silicon: still sleeps. Clamshell or leave lid open.');
  say(`  • After restart, ${join(logDir, 'service.out.log')} should show`);
  say('    "[scheduler] catch-up …" then "pushed …" for the current slot.');

  return lines.join('\n');
}
