// Loads config.yaml (falling back to config.example.yaml) and env vars.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import 'dotenv/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = join(ROOT, 'config', 'config.yaml');
const EXAMPLE_PATH = join(ROOT, 'config', 'config.example.yaml');

export async function loadConfig() {
  const path = existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
  const cfg = yaml.load(await readFile(path, 'utf8')) || {};

  cfg.board = cfg.board || {};
  cfg.board.rows = cfg.board.rows || 6;
  cfg.board.columns = cfg.board.columns || 22;
  cfg.schedule = cfg.schedule || [];
  cfg.apps = cfg.apps || {};
  cfg.options = cfg.options || { keepOnError: true };
  if (cfg.options.keepOnError === undefined) cfg.options.keepOnError = true;
  if (cfg.options.wakeLeadMinutes === undefined) cfg.options.wakeLeadMinutes = 3;

  cfg.env = {
    apiKey: process.env.VESTABOARD_LOCAL_API_KEY || '',
    enablementToken: process.env.VESTABOARD_ENABLEMENT_TOKEN || '',
    host: process.env.VESTABOARD_HOST || 'vestaboard.local',
    port: Number(process.env.PORT) || 3000,
  };
  cfg.usedExample = path === EXAMPLE_PATH;
  return cfg;
}

// Persist the in-memory config. The admin schedule editor always writes
// config.yaml (never the example file) so later saves and restarts agree.
export async function saveConfig(cfg) {
  const payload = {
    board: {
      rows: cfg.board.rows,
      columns: cfg.board.columns,
      timezone: cfg.board.timezone || 'America/Los_Angeles',
    },
    options: {
      keepOnError: cfg.options.keepOnError !== false,
      wakeLeadMinutes: cfg.options.wakeLeadMinutes ?? 3,
    },
    schedule: (cfg.schedule || []).map(({ cron, app }) => ({ cron, app })),
    apps: cfg.apps && Object.keys(cfg.apps).length ? cfg.apps : {},
  };
  const text = `# Vestaboard OS configuration.
# Written by the admin site (Daily Schedule). See config.example.yaml for field notes.

${yaml.dump(payload, { lineWidth: 88, noRefs: true })}`;
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, text, 'utf8');
  cfg.usedExample = false;
}
