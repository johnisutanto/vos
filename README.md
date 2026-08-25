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
  service/     launchd agent for running in the background (macOS)
  web/         admin site (server + static UI)
  engine.js    wires apps + layout + client together
  index.js     entrypoint / CLI
```

## Setup

1. **Install** (needs Node ≥ 20):
   ```bash
   npm install
   ```
   The repo pins `registry.npmjs.org` in `.npmrc` so this works off the
   Salesforce VPN. Do not delete that file — without it, a work-laptop
   `~/.npmrc` will bake Nexus URLs back into `package-lock.json`.
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

## Running in the background (macOS)

`npm start` only keeps the schedule alive as long as the terminal is open. To
have the board keep updating after a reboot, run vos as a **launchd user
agent** — either with the **Background service** toggle on the admin site, or
from the CLI:

```bash
node src/index.js service status      # is it installed / running?
node src/index.js service diagnose    # why isn't the Mac waking / catching up?
node src/index.js service install     # enable  (writes the plist + starts it)
node src/index.js service uninstall   # disable (stops it + removes the plist)
```

The agent supervises a single long-lived `vos serve`, so `config/config.yaml`
remains the only place timing is defined — nothing is duplicated into launchd.
`KeepAlive` restarts the process if it exits. Logs land in `logs/service.out.log`
and `logs/service.err.log`.

Enabling also installs **scheduled wakes** (a one-time macOS admin prompt): a
root LaunchDaemon keeps a rolling two-week window of `pmset` one-shot
wake-or-power-on events, a few minutes before each slot (`options.wakeLeadMinutes`,
default 3). That is what gets a sleeping Mac up in time. We do **not** use
`pmset repeat`, which can only hold one repeating wake and would clobber
anything else already on that Mac.

Install is machine-local. The generated plists capture **this** Mac's node
binary (`process.execPath`), **this** checkout directory, and **this** user's
home. Copying the repo to another computer is fine; run `install` (or flip the
toggle) **on that computer** so it writes its own paths. Do not copy the plists
between machines.

| | |
|---|---|
| User agent | `local.vos` → `~/Library/LaunchAgents/local.vos.plist` |
| Wake daemon | `local.vos.wake` → `/Library/LaunchDaemons/local.vos.wake.plist` |
| pmset owner tag | `local.vos` (only these events are cancelled on disable) |

The plists are generated — re-running `install` overwrites them, so change
`config/config.yaml` or `.env` rather than editing them by hand.

Things worth knowing:

- **Toggling from the UI restarts the server.** Enabling hands the port to the
  supervised copy and exits the foreground process, so the page reconnects on
  its own after a moment. Disabling stops the process serving that page — the
  admin site goes away until you run `npm start` again.
- **macOS will ask for your password** when you enable or disable, because
  `pmset schedule` requires root. A cancelled prompt leaves the previous state
  unchanged.
- **Sleep is still not backfilled by cron.** If a slot is missed, `node-cron`
  does not run it late. vos **does** catch up when the process is awake again
  (lid opened, clamshell, reboot): it pushes the slot that should currently
  be on the board.
- **Closing a MacBook lid usually will not wake it.** `pmset` scheduled wakes
  work for *idle* sleep (lid open, display off). On Apple Silicon, the lid
  magnet forces a deeper sleep that macOS typically will not break for a
  software wake. `caffeinate` cannot override that. To have the board update
  on schedule with the lid shut, use **clamshell mode**: power adapter +
  external display (a cheap HDMI dummy plug counts), *then* close the lid.
  Or leave the lid open and lock the screen. Run `node src/index.js service
  diagnose` on that Mac to see whether wakes are registered and what the
  power log says.
- After you edit the schedule, either wait up to an hour for the wake daemon
  to refresh, or toggle the service off and on.

> **Not macOS?** The toggle hides itself and the CLI exits with a message.
> Use systemd (`systemd --user`) or a supervisor of your choice to run
> `node src/index.js serve`. There is no equivalent of `pmset` in this repo.

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
- The admin site has no auth — run it on a trusted LAN. The one exception is
  the `/api/service` routes behind the background-service toggle: those install
  and remove a launchd agent, so they reject any caller that is not on the
  loopback interface. The toggle is hidden when the page is opened from another
  machine.
