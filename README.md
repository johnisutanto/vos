# Vestaboard OS (`vos`)

A lightweight Node.js service that rotates useful content onto your
[Vestaboard](https://www.vestaboard.com/) throughout the day using the
[Local API](https://docs.vestaboard.com/docs/local-api/introduction) —
morning weather, a daily quote, an afternoon market wrap, headline news, and
anything else you build. Each screen is a self-contained **app** with a
**manifest**, and a small **admin website** shows the schedule and live-previews
what each app will display on the board.

Targets the **Flagship** board (6 rows × 22 columns). All the built-in apps use
**free, no-API-key** data sources.

## How it works

- A **scheduler** (`node-cron`) fires at times you configure, renders the active
  app to a 6×22 grid of Vestaboard character codes, and writes it to the board.
- An **admin website** (Express + static UI) shows a daily timeline and a
  split-flap preview of each app, with a "Push now" button per app.
- **Apps** are plugins: drop a folder under `src/apps/<id>/` with a
  `manifest.json` and an `index.js` exporting `render()`. The registry
  auto-discovers it — no core changes needed.

```
src/
  vestaboard/  Local API client + character-code map
  render/      layout helper (text -> 6x22 grid: wrap, align, color chips)
  apps/        weather, quote, market, news (+ your own)
  scheduler/   cron loop
  web/         admin site (server + static UI)
  engine.js    wires apps + layout + client together
  index.js     entrypoint / CLI
```

## Setup

1. **Install** (needs Node ≥ 20):
   ```bash
   npm install
   ```
2. **Configure:**
   ```bash
   cp .env.example .env
   cp config/config.example.yaml config/config.yaml
   ```
3. **Get your API key.** Request an enablement token at
   [vestaboard.com/local-api](https://www.vestaboard.com/local-api) (arrives by
   email). Then either:
   - Put the token in `.env` as `VESTABOARD_ENABLEMENT_TOKEN` and run
     `npm run enable` — it calls the board once and prints your persistent
     `VESTABOARD_LOCAL_API_KEY` to add to `.env`; **or**
   - If you already have the API key, just set `VESTABOARD_LOCAL_API_KEY`.

## Run

```bash
npm start          # scheduler + admin site at http://localhost:3000
npm run dev        # same, with auto-reload
npm run check      # offline: verify layout + that each app renders a valid grid
node src/index.js preview quote   # print an app's output to the terminal
node src/index.js push quote      # render + write one app to the board now
```

Open `http://localhost:3000` for the admin site. Previews work **without** an
API key or a board on the network — only writes need them.

## Configuring the schedule

`config/config.yaml` is the source of truth. Map cron expressions to app ids:

```yaml
schedule:
  - cron: "0 7 * * *"    # 7:00 AM
    app: weather
  - cron: "0 12 * * *"   # noon
    app: quote
  - cron: "0 13 * * *"   # 1 PM PT — after the 4 PM ET market close
    app: market
  - cron: "0 18 * * *"   # 6 PM
    app: news
```

> **Timezone:** cron fires in the **host's** local timezone. The default
> `market` slot (`0 13 * * *`) assumes the host is on US Pacific time so it runs
> after the 4 PM ET close — adjust for your host.

Override an app's config under `apps:`:

```yaml
apps:
  weather:
    latitude: 47.6837
    longitude: -122.2969
  news:
    feedUrl: https://feeds.npr.org/1001/rss.xml
```

## Writing a new app

Create `src/apps/<id>/manifest.json`:

```json
{
  "id": "myapp",
  "name": "My App",
  "description": "What it shows.",
  "schedule": [{ "cron": "0 9 * * *", "label": "Morning" }],
  "config": { "anything": "you need" }
}
```

And `src/apps/<id>/index.js`:

```js
export async function render({ config, layout, now }) {
  // Return an array of up to 6 strings...
  return layout.lines(["HELLO", "WORLD"], { align: "center" });
  // ...or a raw 6x22 array of character codes for full control (color chips, art).
}
```

`layout` gives you `lines()`, `wrap()`, `textToRow()`, `colorRow()` and the
`COLORS` map (codes 63–70). Text is uppercased; unsupported characters render
as `?`. Add the app to `config.yaml`'s `schedule` to put it in rotation.

## Built-in apps

| App       | Source                                   | Key? |
|-----------|------------------------------------------|------|
| `weather` | US National Weather Service (`api.weather.gov`) | No |
| `quote`   | Bundled `quotes.json` (rotates by day)   | No   |
| `market`  | Stooq CSV quotes                         | No   |
| `news`    | Public RSS feed (NPR by default)         | No   |

## Notes

- Use IPv4 for the board — the Local API is unreliable over IPv6. If
  `vestaboard.local` doesn't resolve, set `VESTABOARD_HOST` to the board's IP.
- On a render/network error the scheduler logs it and **leaves the board on its
  previous content** (`options.keepOnError`) rather than blanking it.
- The admin site has no auth — run it on a trusted LAN.
