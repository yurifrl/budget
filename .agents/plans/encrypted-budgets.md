# Plan: per-budget end-to-end encryption

Status: idea / discussion (2026-11-21). No code yet.

## Goal

Let a user turn on encryption for one budget so that only the budget's
members can read its data. System admins, with full access to the database,
backups and server memory, see only ciphertext.

This is a zero-knowledge design, as in 1Password, Signal, Proton and Actual.
Ordinary budgets keep working exactly as today; an encrypted budget is a
second mode with fewer features.

## How it works

1. **Key from a user secret.** The device derives a key from a passphrase
   only the user knows (e.g. Argon2id). The passphrase and key never leave the
   device. Google / Cloudflare Access sign-in still proves identity but gives
   no secret, so the passphrase is in addition to sign-in.
2. **Key hierarchy.** Each user has a key pair; the private key is stored on
   the server wrapped by the passphrase key. Each encrypted budget has a random
   budget key, wrapped once per member with that member's public key.
3. **Encrypt on the device.** Rows are encrypted before upload; the server
   stores and syncs opaque blobs.
4. **Decrypt and compute on the device.** Balances, reports, graphs and search
   run locally on the decrypted model.
5. **Recovery key.** Shown once when encryption is turned on. Losing both the
   passphrase and the recovery key means the budget is gone; an admin cannot
   reset it.

## What is encrypted

Encrypt all content, not just transactions: an unencrypted plan alone reveals
income, spending by category and goals.

| Encrypt (content) | Leave readable (structure) |
|---|---|
| Transactions and splits: amount, date, payee, memo, category | Row ids and owning budget id |
| Accounts: name, balances, institution | Budget membership (who shares with whom) |
| Plan: categories, groups, assignments, targets, notes, bundles | Revision counter and timestamps, for sync |
| Payees, rename rules, payee locations | User email and login data |
| Repeat rules and scheduled transactions | Row counts and blob sizes (unavoidable) |
| Budget name, month notes | |

Admins can still see that a budget exists, who is in it, how active it is and
roughly how big it is.

## Graphs and reports

Computed on the device from the decrypted local model. The client already
holds one (`useBudgetModel`, `useBudgetMonth`), so this fits the current
architecture. Open question: how much balance/report math runs on the server
today; each such path needs a client-side equivalent (candidate home: pure
functions in `shared/src/domain/`, usable by both sides).

Performance is fine for personal budgets (tens of thousands of rows). The
cost is the first load on a new device: download and decrypt everything.

## Backend processing in an encrypted budget

Nothing "breaks correctly" by itself. Every server feature must be explicitly
disabled or moved to the device for encrypted budgets.

| Feature | Encrypted-budget behaviour |
|---|---|
| Server validation and rules (transfers, card payments, goals) | Server checks only structure and membership; rules run on the client |
| Balances, auto-assign, payee suggestions | Client |
| Repeat rules generating transactions | Generated when the app opens, not by the worker |
| Bank sync | Disabled in v1 (see below) |
| MCP and CLI tools | Unavailable via the server; later possibly a local tool holding the key |
| Export and restore | On the device; server-side export is ciphertext only |
| Search and filtering | Client |
| Admin SPA / jobs ledger | Shows only metadata |

**Bank sync** is the hard exception. The server could encrypt each incoming
transaction to the budget public key and drop the plaintext, but it sees the
data on arrival and holds the bank token, so the promise does not hold for
linked accounts. v1: no bank sync in encrypted budgets; manual file import
on the device instead. If added later, disclose it clearly.

## Turning it on

- Warning screen: passphrase required, recovery key shown once, data lost if
  both are lost, features disabled (list them).
- The device downloads the budget, encrypts it, uploads ciphertext; the server
  then deletes the plaintext rows.
- Existing database backups still hold the old plaintext until they expire;
  the warning must say so.
- Turning it off: the device decrypts and uploads plaintext (simple, but the
  user must hold the key).

## Shared budgets

- Every member needs a key pair (i.e. a passphrase) before joining.
- Inviting: an existing member's device wraps the budget key for the new
  member's public key, so a member must be online to complete an invite.
- Removing a member: rotate the budget key and re-encrypt, otherwise the
  removed member's old key still opens new data.

## Limits of the guarantee

The admin ships the client. A malicious or coerced admin could serve a
modified web client that exfiltrates keys. The honest promise is "admins
cannot read stored data, and cannot read anything without deliberately
shipping a malicious client". Native app-store builds and an open-source
client narrow the gap; nothing closes it.

## Compliance note

Neither GDPR nor LGPD requires E2EE; encryption is one example of an
"appropriate measure". E2EE does not by itself make the app compliant. If
users outside the household sign up, the basics still apply: privacy notice,
lawful basis, export and deletion on request, retention limits (raw bank
payloads in `connection_events` / `connection_transactions`, job logs),
processor agreements (bank aggregator, hosting, Google, Cloudflare), breach
process. Not legal advice.

## Recommended v1 scope

1. Per-budget toggle, all content encrypted.
2. Passphrase + recovery key, per-user key pair, per-budget key wrapped per
   member.
3. Client computes everything for encrypted budgets.
4. Disabled for encrypted budgets: bank sync, MCP/CLI, server-side repeat
   generation, server export.

## Open questions

- Which server-side computations exist today and must be ported to the client?
- Storage shape: one encrypted blob per row (keeps ids, sync, revision) vs a
  CRDT/op log like Actual.
- Conflict handling when two devices edit the same encrypted row.
- Crypto library choice for Expo (iOS) and web (WebCrypto vs libsodium).
- Every future budget feature must work in both modes or be declared
  plain-only; how to enforce that (lint, contract flag `encryptedSupport`?).
