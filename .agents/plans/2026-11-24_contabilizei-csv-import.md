---
title: Import Contabilizei account statement CSV
date: 2026-11-24
description: Recognize the Contabilizei (PJ bank account) CSV export as its own statement source, with the right payee and a stable import id so re-imports are a no-op.
tags: [import, client, parsers, contabilizei]
---

# Import Contabilizei account statement CSV

## The file

Sample: `~/Downloads/31132424_01OUT2026_31OUT2026.csv` (filename = `<account>_<DDMMMYYYY>_<DDMMMYYYY>.csv`).

```
Data,Categoria,Lançamento,Descrição,Entrada,Saída,Saldo do dia
05/10/2026,Pessoa Jurídica,PIX,YURI FREIRE LIMA,-,"R$ 10.000,00","-R$ 10.000,00"
29/10/2026,Pessoa Jurídica,PIX,NSX BRASIL S.A.,"R$ 2.500,00",-,"R$ 73.460,41"
```

- UTF-8 with BOM, CRLF line endings, comma delimiter, quoted money cells.
- Money is pt-BR with a non-breaking space after `R$` (`R$ 10.000,00`).
- One side is empty and written as `-`.
- `Categoria` is always "Pessoa Jurídica" (account type, not a budget category).
- `Lançamento` is the transaction type (PIX / Pagamento / Outros).
- `Descrição` is the counterparty (the real payee).
- `Saldo do dia` is a per-day figure; not needed for import.
- There is no transaction id column.

## What happens today

`parseStatementFile` → `parseImportCsv` (generic). I ran it on the sample:
dates and amounts come out correct (11 rows, 0 errors), but:

1. **Wrong payee.** The generic `payee` pattern matches both `Lançamento`
   and `Descrição`, and the first one wins, so every payee is "PIX",
   "Pagamento" or "Outros".
2. ~~**Not idempotent.**~~ (Review correction: this finding was wrong —
   id-less rows are not duplicated.) The server already generates a
   YNAB-style id for rows with no `import_id`
   (`YNAB:<milliunits>:<date>:<payeeId>:<occurrence>`, the occurrence
   counted against the account's existing rows —
   `api/src/budget/routes/transactions.ts`, POST /bulk), so re-importing
   the same month dedupes server-side. No client id needed.

## Design

Add a dedicated, zero-config source next to Nubank, following the same
pattern. Leave the generic parser alone: Itaú relies on `lançamento`
being the payee there.

### `client/src/features/import/parsers/sources/contabilizei.ts` (new)

- `detectContabilizeiCsv(text): boolean`: the header row (after BOM
  trim) contains `Data`, `Lançamento`, `Descrição`, `Entrada`, `Saída`
  and `Saldo do dia`. The `Saldo do dia` column together with the
  Lançamento + Descrição pair is what makes it distinct.
- `parseContabilizeiCsv(text): ImportParseResult` (plain rows, no
  client-side id):
  - `date` ← `Data` via `parseImportDate`
  - `payee` ← `Descrição` (trimmed)
  - `memo` ← `Lançamento` (PIX / Pagamento / Outros)
  - amounts ← `Entrada` / `Saída`; a `-` or empty cell means 0. Use
    `parseImportAmount`, which already handles `R$ …` (checked on the
    sample). Treat a bare `-` as empty before parsing.
  - Net the two sides: `signed = inflow − outflow`, split back into
    outflow/inflow by sign, so a negative cell reverses its side
    (a `-R$ 5,00` under `Saída` becomes an inflow) and no negative cents
    are ever emitted. Net zero → `line N: amount is zero` (already
    mapped in `flow/parserMessages.ts`); both sides empty/`-` →
    `line N: no readable amount`.
  - **No client import id**: rows are sent id-less and the server's YNAB
    fallback key handles re-imports —
    `YNAB:<milliunits>:<date>:<payeeId>:<occurrence>` with the
    occurrence counted against the account's existing rows (POST /bulk).
    That key includes the payee and is anchored to the database, so it
    is strictly better than any client-side `contabilizei:<date>:<milli>:<n>`:
    with overlapping exports listing same-day same-amount rows for
    different payees in a different order, a client ordinal would drop
    one row and duplicate another. The parser's only job is the right
    column mapping.

### Wiring

- `sources/statement.ts`: in `parseStatementFile`, check
  `detectContabilizeiCsv(text)` before the Nubank check and route to
  `parseContabilizeiCsv`. Update the doc comment.
- `parsers/index.ts`: export `detectContabilizeiCsv`,
  `parseContabilizeiCsv` and `ContabilizeiRow`.
- The draft rows already pass `importId` through (`assoc.ts`
  `DraftImportRow.importId` → `budget/data/mapping.ts` sets
  `wire.import_id`). Check that `useImportFlow` copies `importId` for
  any source and does not special-case Nubank; if it does, make that
  check generic (`'importId' in row`).
- i18n (`features/import/i18n/en.ts` + `pt-BR.ts`): add "Contabilizei
  CSV" to `screen.subtitle` and `file.hint`. No new error strings: the
  per-line errors reuse the existing `line N: bad date` / `no readable
  amount` messages handled by `parserMessages.ts`.

### Out of scope

- Using `Saldo do dia` for reconciliation.
- Latin-1/Windows-1252 exports (the sample is UTF-8; add this only if
  a real file shows up).
- Taking the account number from the filename.

## Done when (checks)

1. `client/src/features/import/parsers/import.test.ts`: a new
   `describe("parseContabilizeiCsv")` using an inline copy of the sample
   (with BOM, CRLF, NBSP and `-` cells). It asserts:
   - 11 rows, 0 errors
   - row 1 = `{date:'2026-10-05', payee:'YURI FREIRE LIMA', memo:'PIX', outflowCents:1000000, inflowCents:0}`
   - the DARF row: payee "DARF Unificado", memo "Pagamento", outflow 17831
   - the NSX inflows are 250000 and 7096041
   - every `importId` is unique, and parsing twice gives identical ids
   - two identical same-day rows get `:1` and `:2`
2. A `parseStatementFile` test: the sample routes to the Contabilizei
   source (payee is not "PIX", and rows have `importId`). Existing
   Nubank, Itaú and generic tests still pass.
3. `detectContabilizeiCsv` returns false for the Nubank conta/fatura
   and generic YNAB fixtures already in the test file.
4. Run in `client/`: `bunx tsc --noEmit`, `bunx eslint .`,
   `bun test`. All green, i18n lint included.
5. Manual: import the sample into a dev budget account on web (:8091):
   11 rows with the right payees. Import it again: 0 new rows (all
   skipped as already imported). Screenshot both and attach to the tk
   task.

## Execution

One tk task ("Import Contabilizei statement CSV"), one Sonnet worker in
the `tk work` worktree (well-specified, about 150 lines including the
test), and a fresh reviewer session before `tk finish`.
