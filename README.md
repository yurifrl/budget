# Budget

Personal budgeting app, moved out of syscd-app.

- `client/` Expo app (iOS + web)
- `api/` Bun + Hono API
- `shared/` pure TypeScript contracts used by both (zod only)
- `deploy/` Dockerfiles

There is no root `package.json`. Each package installs on its own:

    mise install
    task install
    task test
    task typecheck

See `docs/decisions.md` for how `shared/` is wired in.
