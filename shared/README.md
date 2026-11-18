# shared

Pure TypeScript used by `client/`, `api/` and (later) `admin/`. Depends on zod
only: no hono, pg, react, `node:*` or `process.env`. Consumed as source through
the tsconfig path `@shared/*` -> `shared/src/*`.

Import convention:

- `@shared/contracts/<feature>` for `budget`, `connections`, `rates`, `user`,
  `oauth`, `jobs` (barrel: every contract plus its `contracts` list)
- `@shared/domain/payees`, `@shared/domain/transfers` (pure domain logic)
- `@shared/operation-contract` (`defineOperation`, `collectContracts`, ...)
- `@shared/validation` (pure uuid/date/cents zod validators)
- `@shared/zod`: the only place zod is imported. Never `import 'zod'` elsewhere.

`shared/` must be installed first (`bun install` here): client and api link zod
to `shared/node_modules/zod`. Run `bun test` and `bunx tsc --noEmit` from here.
