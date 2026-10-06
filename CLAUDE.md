# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Production server (node server.js) — http://localhost:7700
npm run dev      # Same with --watch auto-reload
npm run images   # Rebuild favicon / PWA icons / og.png from public/img/*.svg (needs dev deps)
```

No test or lint tooling is configured. No build step: `public/` is served as-is, JS uses native ES modules.

## Environment

Copy `.env.example` to `.env`. `PORT` 7700 (3000/3001/3002/7000/7500/7600 are taken on the VPS),
`HOST` (127.0.0.1 in prod), `BASE_URL` (injected into pages as `{{BASE_URL}}`, used by robots/sitemap/OG),
`DB_PATH`, `RETENTION_DAYS`, `CREATE_PER_HOUR`.

## Architecture

**Stack:** Express + better-sqlite3, vanilla JS front. No accounts, no sessions, no cookies.

**Server** (`server.js`, `db.js`, `middleware/rateLimit.js`) is deliberately thin. A plan is one row in
`plans`: `view_id` (10 chars, read link `/p/:id`), `edit_token` (24 chars, edit link `/e/:token`), `data`
(the whole plan as opaque JSON), `version` (optimistic concurrency), `last_seen_at` (purge after
`RETENTION_DAYS`). API under `/api/plans`: `POST /`, `GET /view/:id`, `GET|PUT|DELETE /edit/:token`,
plus `GET /api/health` (used by `deploy.sh`). `PUT` takes `{ version, data }` and returns 409 with the
current plan when the version is stale.

**Front** (`public/js`):
- `lib/model.js` — the plan shape (documented at the top) and every derived value: date helpers (UTC
  only), weeks, budget per person, `Resto n/N` counters, meals still to decide. Nothing derived is stored.
- `lib/templates.js` — starter templates applied at creation.
- `lib/weather.js` — Open-Meteo geocoding (with a prefix fallback: compound names like
  « Port-la-Nouvelle » return nothing otherwise) and 16-day forecast, cached in sessionStorage.
- `lib/util.js` — `esc()` (every user string goes through it), icons, modals, toasts, theme.
- `lib/recent.js` — « Mes plannings récents » in localStorage.
- `planner.js` — the plan page. Whole-page re-render on every change via `commit()`, which also schedules
  the autosave. Event delegation through `data-action` / `data-change` / `form[data-add]`.
  Desktop shows the grid (`.grid-view`), < 820px shows the day-by-day view (`.day-view`); both are always
  rendered and toggled by CSS.
- Printing: `openPrintModal()` (options + live preview) and `beforeprint` both call `preparePrint()`, which
  renders `.print-sheet` pages into `#print-root` (hidden off-screen, the only thing shown in print media).
  `fitSheet()` gives each sheet a CSS `zoom` so it fits one A4 landscape page (1062×724 px): it lays out at
  `PAGE_W / zoom` wide, never narrower than `MIN_DAY_COL` per day, then stretches the table to fill spare
  height. Sheet styles are media-independent (light palette forced on `.print-sheet`) so screen measurement
  matches print.

**CSP is strict** (`script-src 'self'`): no inline scripts or `onclick`. `connect-src` allows only the two
Open-Meteo hosts.

## Deployment

Push on `main` → GitHub Actions SSHes with a key restricted to `/var/www/HolidayHub/deploy.sh` → reset to
`origin/main`, `npm ci` only if the lockfile changed, `pm2 restart holidayhub`, health check with automatic
rollback. Never track `data/`, `*.db*` or `.env` (the deploy does `git reset --hard`).
