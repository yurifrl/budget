# Changelog

## v2026.11.18 2026-11-18 release

### Changed

- chore: ignore .worktrees in .gitignore
- docs: AGENTS.md, architecture, README; release bump moves api and client VERSION together
- feat: admin SPA, deploy images, k8s image tags, release scripts, CI workflows, Taskfile
- docs: record why the phase 3 level-2 smoke test did not run
- docs: phase 3 decisions and smoke-test evidence
- test(api): pin that future-dated writes without deltas move the balance (syscd parity); correct decisions note
- docs: record phase 2 decisions
- feat(api): lift server core, user, oauth, mcp, cli, jobs, budget, connections, rates from syscd-app
- feat(api): carry db migrations (33, unchanged), dev seed, test preload and e2e scripts
- feat(shared): drop client balance deltas from transactions contracts (G13), add eslint config
- build(client): deps, VERSION-based app config, layering lint
- feat(client): static store, settings menu host and root routes
- feat(client): auth and profile features
- feat(client): platform and ui subset from syscd core
- feat(client): copy modules/budget into client/src/budget
- chore: record phase 1 task finish
- chore: initialise tk task tracking with migration phases
- feat(shared): copy operation contracts for budget, connections, rates, user, oauth, jobs
- feat(shared): copy payees and transfers domain with tests, add pure validators
- docs: record phase 0 decisions and spike results; note zod override in plan
- chore(mise): use the registry name 'task' for go-task
- build: API Dockerfile with repo-root context installing shared/ then api/
- feat(client): Expo SDK 58 app with hello screen calling shared contract
- feat(api): Hono hello route, MCP + Temporal spike tests, zod-ban lint
- feat(shared): operation contract, zod re-export, hello_get contract
- chore: start Budget repo (source: syscd-app 8e79a31)

