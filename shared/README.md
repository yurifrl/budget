# shared

Pure TypeScript used by `client/`, `api/` and `admin/`. Depends on zod only:
no hono, pg, react, `node:*` or `process.env`. Consumed as source through the
tsconfig path `@shared/*` -> `shared/src/*`.

Import convention:

- `@shared/contracts/<feature>` for `budget`, `connections`, `rates`, `user`,
  `oauth`, `jobs` (barrel: every contract plus its `contracts` list; `budget`
  and `connections` also export their output row schemas)
- `@shared/operation-contract` (`defineOperation`, `collectContracts`,
  `OperationOutput`, ...)
- `@shared/contract-request` (`contractRequest(contract, input)`: the HTTP
  request a client sends; used by the app's RTK Query slices and the admin)
- `@shared/errors` (the `{ error, code }` error body and its codes)
- `@shared/domain/payees`, `@shared/domain/transfers` (pure domain logic)
- `@shared/validation` (uuid/date/money/currency zod validators)
- `@shared/zod`: the only place zod is imported. Never `import 'zod'` elsewhere.

## Contracts

One `defineOperation` per endpoint: name, description, `input` (one flat zod
object; path, query and body keys), `output` (the 2xx JSON body after
serialization; `z.null()` for a 204), method, path, kind, expose. Every
budget and connections operation has an `output`. From one contract:

- the API mounts the route and validates input (`api/src/core/operation.ts`);
  in tests (and with `API_VALIDATE_OUTPUT` in local dev) it also checks every
  handler result against `output`;
- the CLI and MCP tools are generated (MCP advertises `output` as the tool's
  `outputSchema` when it is an object);
- clients build requests with `contractRequest` and type responses with
  `z.infer` / `OperationOutput<typeof contract>`.

## Money

**Every amount on the wire, in both directions, is an integer number of
milliunits** (1/1000 of the currency unit: 12.34 = 12340). **Amount fields have
no unit suffix** (`amount`, `inflow`, `outflow`, `balance`, `budgeted`,
`limit`, ...); nothing on the wire is named `*_cents`. Use `milliunitsSchema`
(`nonNegativeMilliunitsSchema` for one-way legs) from `@shared/validation`, and
say "integer MILLIUNITS (12.34 = 12340)" in the operation description: that is
what CLI and MCP users read. Any integer is accepted; the app writes multiples
of 10. Exception: category targets are stored in whole cents, so their
`amount` must be a multiple of 10. Backups carry `format_version: 2`;
`upgradeRestorePayload` reads the legacy cents format (absent or 1).

## Errors

Non-OAuth error responses are `{ error, code }` (`@shared/errors`): `error` is
the human message (unchanged), `code` a stable identifier: the status default
(`bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`rate_limited`, `internal`, `upstream_error`, `unavailable`,
`upstream_timeout`, else `error`) or a specific one (`invalid_input` for
validation failures, `account_disabled`, `insufficient_scope`,
`already_archived`).

`shared/` must be installed first (`bun install` here): client, api and admin
link zod to `shared/node_modules/zod`. Run `bun test` and `bunx tsc --noEmit`
from here.
