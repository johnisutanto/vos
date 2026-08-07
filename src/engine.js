// The engine wires apps, layout, and the Vestaboard client together.
// It is the single object the scheduler and web server call into.

import { createLayout } from './render/layout.js';
import { loadApps } from './apps/registry.js';
import { VestaboardClient } from './vestaboard/client.js';
import { isValidGrid } from './vestaboard/characters.js';

export async function createEngine(cfg) {
  const { rows, columns } = cfg.board;
  const layout = createLayout({ rows, columns });
  const apps = await loadApps(cfg.apps);
  const client = new VestaboardClient({
    host: cfg.env.host,
    apiKey: cfg.env.apiKey,
    rows,
    columns,
  });

  // Render an app to a validated grid (does NOT write to the board).
  async function renderApp(id) {
    const app = apps.get(id);
    if (!app) throw new Error(`Unknown app: ${id}`);
    const result = await app.render({ config: app.manifest.config, layout, now: new Date() });
    const grid = normalizeToGrid(result, layout);
    if (!isValidGrid(grid, rows, columns)) {
      throw new Error(`App "${id}" produced an invalid ${rows}x${columns} grid`);
    }
    return grid;
  }

  async function writeGrid(grid) {
    return client.write(grid);
  }

  return { layout, apps, client, rows, columns, renderApp, writeGrid };
}

// Apps may return an array of strings (lines) or a raw code grid.
function normalizeToGrid(result, layout) {
  if (Array.isArray(result) && Array.isArray(result[0]) && typeof result[0][0] === 'number') {
    return result; // already a code grid
  }
  if (Array.isArray(result)) return layout.lines(result); // array of strings
  throw new Error('App render() must return an array of strings or a code grid');
}
