// Loads config.yaml (falling back to config.example.yaml) and env vars.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import 'dotenv/config';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function loadConfig() {
  const configPath = join(ROOT, 'config', 'config.yaml');
  const examplePath = join(ROOT, 'config', 'config.example.yaml');
  const path = existsSync(configPath) ? configPath : examplePath;
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
  cfg.usedExample = path === examplePath;
  return cfg;
}
