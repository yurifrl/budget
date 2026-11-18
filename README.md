# Budget

Personal budgeting app, moved out of syscd-app.

- `shared/` pure TypeScript contracts and domain, used by the others (zod only)
- `api/` Bun + Hono API, jobs worker, CLI, MCP
- `client/` Expo app (iOS + web)
- `admin/` Vite SPA for the jobs ledger
- `deploy/` Dockerfiles, `k8s/` image tags, `.github/workflows/` CI and release

There is no root `package.json`. Each package installs on its own, `shared/`
first (the others link to its zod). Local dev:

    mise install
    task install
    task deps        # terminal 1: Postgres + Temporal (reuses :5432 if present)
    task run         # terminal 2: api :3100, worker, admin :5191, web :8091

Checks: `task typecheck`, `task lint`, `task test` (api tests need Postgres on
localhost:5432, databases `budgetnew_*` only).

Docs: `AGENTS.md` (commands, rules, adding an endpoint), `docs/architecture.md`,
`docs/decisions.md`, `docs/migration-plan.md`.
