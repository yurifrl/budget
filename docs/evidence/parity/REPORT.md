# Phase 3 parity pass (web)

Run on 2026-11-18 from branch `fix/parity`. The client ran on the Expo web dev
server (:8092) against the real API (:3100, auth disabled, no Temporal) on
`budgetnew_dev`. It was driven with `agent-browser` at 1440x900 (`1440/`),
900x1100 (`900/`) and 390x844 (`390/`). The syscd web app that was already
running on :8081 (its own API on :3000, same seed budgets) was opened
read-only for comparison. Nothing was written to it.

## How parity was measured

- **Static screens (15 routes x 3 widths)** were captured in both apps on the
  same budget (Trabalho, which is identical in both seeds) and diffed pixel by
  pixel. The only differing pixels were user or connection data: the footer
  name `Yuri` vs `dev@localhost`, the avatar, syscd's two linked banks, and
  syscd's OAuth grants. Everything else matched exactly: layout, typography,
  colors, rail, drawer, tab bar and FAB.
- **Evidence screenshots** in this folder show the copy on the richer Casa
  budget. The comparison shots stayed in the session scratch dir and were not
  committed.
- **Errors:** after each capture the run checked page errors, console
  `[error]` lines and requests without a 2xx/3xx status. There were no page
  errors, no console errors and no HTTP errors. The only "failed" entries were
  in-flight `GET /budget-revision` polls cancelled by a budget switch, and one
  `GET /connections/sync-status` still pending (it waits about 3 s for
  Temporal, then answers `scheduler_degraded: true`).

## Screens x widths

| Screen | 1440 | 900 | 390 | Notes |
|---|---|---|---|---|
| Home `/` | OK | OK | OK | pixel-identical to syscd |
| Plan `/plan` | OK | OK | OK | identical |
| Plan: inspector, target editor, move money, assign dropdown, auto-assign, person filter, group collapse, group menu, row menu, month switch, add group/category, drag | OK | OK (assign edit, category detail) | OK (numpad panel, FAB parked) | `plan-*.png` |
| All accounts `/accounts` | OK | OK | OK | identical |
| Single account `/accounts?account=` (checking, card) | OK | OK | OK | identical |
| Register: inline add, edit, split, transfer, txn menu, selection bar, bulk flag, search, reconcile, edit account, add account | OK | add-transaction row | add-transaction sheet | `accounts-*.png` |
| Spending | OK | OK | OK | identical |
| Reflect | OK | OK | OK | identical |
| Payees (detail, rename, rule, merge) | OK | OK | OK | |
| Import (CSV walk) | OK | OK (render) | OK (render) | |
| Backup (export, restore) | OK | OK (render) | OK (render) | |
| Connect bank / connection / linked account | OK | OK | OK | no provider: "Background sync is offline…" banner and "No banks linked yet" |
| Settings menu, every pane | OK | OK | OK | 12 panes at 1440; root, Display Options, Back, People-by-request at 900/390 |
| Profile, Connected apps | OK | OK | OK | identical apart from user data |
| Back navigation (rail, nav links, tabs) | FIXED | FIXED | FIXED | regression 1 below |
| Favicon / app icon | FIXED | FIXED | FIXED | regression 2 below |
| Breakpoints 767/768/769/1023/1024 | OK | | | tabs / drawer / rail switch at the same widths as syscd |

Screenshots: 131 PNGs (82 at 1440, 23 at 900, 26 at 390).

## Write flows (verified through the API after each one)

| Flow | Result |
|---|---|
| Switch budget (Open Budget > Casa > Open) | active id persisted; data switched |
| Assign Mercado 700 to 800, undo, redo | 800000, then 700000, then 800000 |
| Move money 50 from Mercado to Transporte | 750000 / 300000 |
| Set target (monthly 1500) | `category_targets` 150000 cents |
| Create group "Parity Group" and category "Parity Cat" | present in API |
| Drag Psiquiatra below Transporte | `sort_order` changed and persisted |
| Inline add, edit amount, delete transaction | -37500, then -42000, then gone |
| Transfer to Poupança | both legs created and linked |
| Split | created through the UI with 1 leg; adding a 2nd leg was not completed (see below) |
| Bulk flag 2 transactions blue | both `blue` |
| Reconcile savings | `last_reconciled_at` set |
| Edit account note, add account "Parity Cash" | saved |
| Payee rename, rename rule, merge | saved; merged count 1 |
| Import a 3-row CSV | 3 rows; rename rules applied |
| Backup export, then restore into Trabalho | 105 transactions; every account balance equals Casa's |
| People: add, rename, remove placeholder | members list matches |
| New, rename and archive budget | created / renamed / `archived_at` set |
| Number format 1,314.51 | stored per budget; amounts re-render only after reload (pre-existing) |
| Phone numpad assign | saved (cents-style entry) |

## Regressions found and fixed

1. **Browser Back left the app after rail, nav-link and tab navigation.** The
   fresh install resolved `expo-router ~58.0.23` to 58.0.31, which replaces
   the history entry on tab navigation. syscd runs 58.0.23, which pushes. In
   fresh sessions: syscd went from history length 2 to 3 and Back returned to
   `/plan`; the copy stayed at length 2 and Back went to `about:blank`.
   Fix: pin `"expo-router": "58.0.23"` (`client/package.json`, `bun.lock`).
   After the pin the copy behaves like syscd, and the pixel diff shows no
   layout change. Commit `2ad1e12`.
2. **No favicon and no app icon.** syscd's config sets `icon` and
   `web.favicon` from `assets/images`; the copy had neither. Fix: copy
   `icon.png` and `favicon.png` into `client/assets/images`, set in
   `client/app.config.ts`. The web export now emits `favicon.ico`. Commit
   `1fc928e`.

Other version drift remains (expo 58.0.25 vs 58.0.14, expo-linking,
expo-constants, @expo/metro-runtime, react-native-screens 4.30.1). None of it
showed a visible or behavioural difference in this pass.

## Checked and not a regression

- The tablet settings menu shows the drawer through it while fading in. syscd
  shows the same frames.
- The trigger pill opens the settings root directly, the root's back button is
  gone, the header reads `SETTINGS vX`, and People-by-request returns to the
  root. All of this is as designed in `decisions.md`.
- The code in `budget/` is unchanged except for imports, casts, route literals
  and the `SettingsMenu` host (normalized diff against syscd). Store wiring is
  equivalent.

## Pre-existing bugs (tk follow-ups)

- `budget-xef`: format prefs do not re-render amounts until reload.
- `budget-xd6`: month note keeps the previous budget's note after a switch.
- `budget-fwf`: New Budget is bounced back to `budgets.data[0]`.
- `budget-rnn`: Enter on partial category text creates a category in Credit
  Card Payments.
- `budget-qal`: the tablet menu fades in over the drawer (same in syscd).
- `budget-ipa`: the Assign dropdown ignores Escape.

## Not verified

- **iOS simulator:** not used (the lease is held by the other repo).
- **Auth-on client flow** (cookie, Bearer token, LoginGate sign-in): only
  auth-disabled mode was run.
- **Multi-leg split editing and dropdown picks via synthetic clicks:** the
  register popovers act on `onPressIn` and the rows move. Picks only work with
  a hover then press. A synthetic click on an option leaves the field empty in
  syscd too, so this is an automation artefact.
- **Number-format comparison inside syscd:** the attempt was blocked by the
  permission classifier and not retried. The verdict comes from identical code.
- **Connect bank with a provider configured, and sync with Temporal up.**
- **Statically served production export:** only the dev server was run against
  the API.
- **Group drag:** only category drag was exercised.

## Client checks after the fixes

`bunx tsc --noEmit` clean; `bunx eslint .` 0 errors, 10 warnings (unchanged);
`bun test` 666 pass / 0 fail (47 files); `expo export --platform web` 1798
modules (favicon emitted); `--platform ios` 2302 modules. api/ and shared/
were not changed.

## Local DB recipe

Shared Postgres `postgres://postgres:postgres@localhost:5432` (no `psql` on
the host; use `pg` from `api/node_modules`). `create database budgetnew_dev`,
apply `api/db/migrations/*.sql` in order except `0010`, then
`api/db/seed/seed.sql`, then `0010_ynab_parity_plan_data.sql` (as in
`api/db/dev-initdb.sh`). Boot from `api/`:
`DATABASE_URL=postgres://postgres:postgres@localhost:5432/budgetnew_dev AUTH_DISABLED_OK=1 API_PORT=3100 TEMPORAL_ADDRESS=localhost:57299 APP_BASE_URL=http://localhost:8092 bun src/index.ts`
(`TEMPORAL_ADDRESS` points at a closed port so the API never reaches syscd's
Temporal on 7233; `APP_BASE_URL` adds the web origin to CORS).
