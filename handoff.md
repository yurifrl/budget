# Handoff — AI category suggestions ("Categorize" page)

Written 2026-11-24 · branch `main` · commit `6d92eab`
Uncommitted: only `.tasks/` records (incl. new task `budget-seoa`) and an untracked `.mcp.json`. No source code changed.

## Goal

A new feature in the budget app, planned but not built:

1. **AI provider layer** that works like Pluggy keys: one shared key for the installation, turned on by a feature flag, plus each user's own key. First provider is OpenRouter; others come later.
2. **Categorizer**: an agent that uses tool calls to read budget data and returns a parsed list of category suggestions with confidence. Runs as a Temporal job over all uncategorized transactions.
3. **"Categorize" page**, separate from the transactions register: a bundle view (accept many at once) and a one-by-one view (one click, next), with different designs for web and mobile.

Done for this stage = the owner has answered the mock questions, the work is filed in tk as an epic with one task per deliverable, and implementation is delegated to agents.

## Where it stopped

- The plan was given in chat and accepted ("perfect").
- A static mock was built and sent to the owner's Plannotator Inbox. Thread `msg_01M86SWYDXDHKFPX415ZB7NYJ7` ("Categorize page (AI category suggestions)"), http://localhost:51065/#thread=msg_01M86SWYDXDHKFPX415ZB7NYJ7
- The owner answered the five mock questions on 2026-11-24 (reply `msg_01M86TKW0X0PP53AENDXS8N1SM`):
  1. Web one-by-one: keys 1/2/3 file at once.
  2. Threshold: nothing is ever applied automatically. Strong suggestions are accepted through bundle accepts; the threshold is configurable.
  3. Without an AI key the page still works by hand ("Categorize by hand" stays).
  4. No single model. Providers: OpenRouter, Anthropic, OpenAI, Z.ai, DeepSeek. Detect the provider from the key, but let the user choose it; once key and provider are set, list the available models to pick from. A feature flag "in config" lets users use AI from our server. Own key: on mobile "save in device securely and never leaves, it is only passed to the llm provider"; on web "safely store it in our database".
  5. The name "Categorize" is fine.
- Follow-up answered on 2026-11-24 (reply `msg_01M86TWAY4464FF86TX2JGB84G`): own keys are stored encrypted in our database on every platform, mobile included ("nevermind the idea of saving the key on the phone, if we save it in the backend we can use same mechanisms"). No questions are open in the thread.
- Mock files: `/private/tmp/claude-501/-Users-yuri-Workdir-Yuri-budget/011e3c6b-8148-4a11-8593-8d1e761197c6/scratchpad/categorize-mock/` (overview `categorize-mock.html`, five standalone screens with PNGs, `build.py` regenerates them, `shoot.sh` retakes screenshots). This is a temp folder; the overview and PNGs are also saved as evidence on tk task `budget-seoa` (open).

## Decisions

- Five providers behind one adapter interface: OpenRouter, Anthropic, OpenAI, Z.ai, DeepSeek. Provider is guessed from the key and can be overridden; models are listed from the provider after the key is set. For the shared server key, the model is an admin setting.
- Flag `shared-ai-key` (default off) in `shared/src/features`; own keys in a new table `ai_credentials`, sealed with `api/src/core/secret-box.ts`. Pattern to copy: `api/src/connections/keys.ts` and migration `api/db/migrations/0104_own_pluggy_keys.sql`.
- Key resolution: own wins, else shared when the flag is on, else an error. No "paused" state (nothing upstream is tied to the key, unlike Pluggy).
- New code lives in `api/src/ai/` (providers) and `api/src/categorize/` (agent, job); contracts in `shared/src/contracts/categorize/`; client in `client/src/features/categorize/`.
- Model tools (read-only, budget-scoped): `get_transaction`, `list_categories`, `payee_history`, `search_similar_transactions`. Output: up to 3 `{category_id, confidence, reason}` per transaction, zod-validated.
- The existing payee rule (`suggestedCategoryForPayee` in `api/src/budget/domain/categorization.ts`) answers first; only the rest goes to the model.
- Suggestions go to a new table `category_suggestions`; the job never writes `transactions.category_id`. Accepting goes through the existing transaction update path.
- Threshold is stored per budget and applied at read time, so changing it needs no re-run.
- One `categorize_run` job per budget (subject key = budget id), registered like `connections_sync` (`api/src/connections/jobspec.ts`, `workflows.ts`), on its own rate-limited `-ai` task queue.
- A bundle = transactions with the same payee and the same top suggestion.
- Order of work: mock → AI provider layer + keys screen → categorizer engine + job → queue/accept contracts → client page (web, then mobile).

## Ruled out

- Keeping the own key only on the phone: dropped by the owner, because a server job cannot use it and it would need a second classifier in the app.
- Suggestion chips inside the existing transactions register: the owner dropped this mid-request in favour of a separate page ("Forget the, my, my 1st thing that I said"). Listed as "later" only.
- Running automatically after every bank sync: later, not in the first version.

## Constraints

- "Again, just plan no coding." Nothing is implemented; do not start coding without the owner's go-ahead.
- This session is an orchestrator in this repo: it scopes, files tk tasks and delegates implementation to agents; it does not write the code itself (owner's standing rule, in memory).
- "we don't want to for satisfy. we want like a threshold of a certainty that we can configure" — read as: never force a category; the threshold is configurable on the page.
- "it should be fast": the owner will classify "lots and lots of things"; one click per transaction.
- Web and mobile get "different designs for both", not a reflow.
- Migrations are additive only (the database is shared with another running app); see `AGENTS.md` for ports, database names and the tk workflow.

## Next step

All questions are answered. File a tk epic with one task per item in "Order of work" (the mock task `budget-seoa` already exists), then brief agents for the AI provider layer first. Coding still needs the owner's go-ahead.

## Verify

`tk show budget-seoa` shows the mock task with 6 evidence files; `git status --short` shows no source changes.

## Unverified

- Whether the bank (Pluggy) payload in `connection_transactions.raw_payload` carries a location. The mock draws the map as conditional; check the payload before promising it.
- Nothing else: the mobile-key question is settled (server storage everywhere).
