// Discovers apps under src/apps/<id>/ and loads each one's manifest + render fn.
// An app is any subdirectory containing a manifest.json and an index.js that
// exports `async render(ctx)`.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APPS_DIR = dirname(fileURLToPath(import.meta.url));

// Returns a Map<id, { manifest, render }>. `overrides` is config.apps from
// config.yaml, merged over each manifest's default config.
export async function loadApps(overrides = {}) {
  const apps = new Map();
  const entries = await readdir(APPS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(APPS_DIR, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    const indexPath = join(dir, 'index.js');
    if (!existsSync(manifestPath) || !existsSync(indexPath)) continue;

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const id = manifest.id || entry.name;
    const mod = await import(pathToFileURL(indexPath).href);
    if (typeof mod.render !== 'function') {
      throw new Error(`App "${id}" is missing an exported render() function`);
    }

    manifest.config = { ...(manifest.config || {}), ...(overrides[id] || {}) };
    apps.set(id, { manifest, render: mod.render, dir });
  }

  return apps;
}
