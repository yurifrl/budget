# Changelog

## v2026.11.27 2026-11-27 release

### Changed

- release: v2026.11.27
- fix(client): bumped expo-image and expo-sharing to SDK 58 patch levels
- wip
- fix(transfers): no auto-link in a group that holds a manual row (budget-dt00)
- fix(transfers): remove the "outside the budget" transfer state (budget-dt00)
- wip
- wip
- wip
- feat(categorize): run of any size, and transfers


## v2026.11.26-01 2026-11-26 release

### Changed

- release: v2026.11.26-01
- feat(categorize): category suggestions with Jev
- REMOVE WRONG AI IMPL


## v2026.11.26 2026-11-26 release

### Changed

- release: v2026.11.26
- test(client): content-keyed notice entries when a rule is changed in the card (budget-p8td)
- fix(client): Convert abort restores exactly (removes created rules), off-failure keeps saved rules with Retry, honest where-it-is messages, duplicate rows refused, stable edit keys, pt-BR wording (budget-p8td)
- docs: drop stray conflict marker from the merge
- wip
- fix(client): Convert cannot lose a rule (409 only done when the target holds it, put-back, retry); notice follows the payee's rules; popover rule 409; clearer notice wording; pt-BR undo agreement (budget-p8td)
- chore(tooling): configure mcp servers and record handoff notes
- docs(plans): add csv import and transfers refactor plans
- fix(client): pointer-less rows resolve exactly as main; explicit convert step; undo for removed rules; review follow-ups (budget-p8td)
- feat(transfers): Always treat X as a transfer writes a renaming rule; no outside-the-budget transfers; legacy name fallback (budget-p8td, checkpoint 3)
- feat(client): a transfer is its payee only; category not needed on on-budget transfers; one transfer account list; payee_id on writes (budget-p8td, checkpoint 2)
- fix(payees): lift the Undo toast above the phone's floating button (budget-p8td)
- feat(payees): Manage Payees with a Transfer Payees group and several renaming rules per payee (budget-p8td, checkpoint 1)
- fix(categorize): rows Done has committed are never offered to the leave prompt or restored locked; Z never passes over them; 400/403/404 leave with a note; prompt note for dropped rows; pt-BR plurals
- fix(rename-rules): syncs take the budget lock shared, apply/revert exclusive with a 5s lock_timeout (409 bank_sync_running), JS-equal trim in the prefilter (budget-ou8p round 4)
- fix(categorize): Done locks the rows it sends (no Undo, re-checked before each request); leave prompt locked while sending and names the budget; retry/refused handling; strip rows kept unless the queue is fully loaded; badge excludes the strip
- wip
- docs: real text order
- fix(rename-rules): bank_text of the latest pull on every path, raw text preferred, revert once, per-budget lock, SQL prefilter, docs (budget-ou8p round 3)
- wip
- fix(categorize): leave prompt works with a page that stays mounted behind the new route (commands to a live page, restore for a gone one)
- feat(categorize): browser leave-site question while rows wait in the strip
- fix(rename-rules): text-based change detection, real bank text for apply, server-recorded revert, exact /bulk text (budget-ou8p review)
- fix(categorize): the leave store is one per app (route modules are evaluated again on re-entry)
- fix(categorize): the shell watches route and budget and asks about rows left in the strip (the navigator does not run the page's cleanup)
- feat(categorize): skips are never sent on a timer: Leaving strip with Done, leave prompt, counts without the strip, no empty undo entry
- docs: rules apply going forward (budget-ou8p)
- test(rename-rules): rules apply going forward, apply/preview/revert (budget-ou8p)
- feat(rename-rules): preview, apply and revert one rule on past transactions (budget-ou8p)
- feat(rename-rules): sync refresh and statement re-import leave stored rows alone when a rule changes (budget-ou8p)
- feat(categorize): keys act only on the page and never under an overlay; page state keyed by budget; pending skips visible in Bundles, dropped when their row leaves, excluded from bulk accepts; countdown, counts, toast and Escape fixes
- fix(categorize): pending-skip line fits its countdown; Run dialog title
- feat(categorize): undo stack in press order, each skip on its own timer with its own Undo; Escape leaves a field, no type-to-search; modal-safe keys; retried undo says already restored; unavailable header wins over an active run
- fix(transfers): /bulk dedupes on the payee field as main keyed it, untouched for statement rows with file ids, case-insensitive edit check (budget-mkrt, round 5)
- fix(categorize): no-key reason independent of an active run, blur after pointer press in capture phase, clear search per row
- fix(transfers): /bulk keeps a new text under a shared key, edits never move a legacy payee, review round 4 (budget-mkrt)
- wip round 4
- feat(categorize): deferred, undoable skip; chunked undo with exact outcome; undo follows the last press; typing and focus safety; bundles stay reachable without a key; run confirmation; filed lines; light badge read
- fix(transfers): legacy rows recognised under every rule form, /bulk occurrences per key, review round 3 (budget-mkrt)


## v2026.11.24-01 2026-11-24 release

### Changed

- release: v2026.11.24-01
- refactor(client): Contabilizei rows rely on server import ids
- fix(client): Contabilizei import ids unique across payees
- feat(client): import Contabilizei statement CSV
- fix(client): close review 2 on the AI key screen
- test(client): gate the AI model list on settled detection
- refactor(client): AI keys review fixes (sequencing, reducer, shared cards)
- refactor(client): align AI key screen with the final ai contracts
- fix(client): handle ai_key_forbidden and keys saved without a model
- fix(client): keep AI key detection from restarting mid-request; show removal notice
- feat(client): AI key screen (save, detect provider, pick model, test, remove)
- fix(ai): third review round for the provider layer (budget-ucyr)
- fix(ai): second review round for the provider layer (budget-ucyr)
- fix(ai): harden the provider layer before the categorizer (budget-ucyr)
- chore(ai): renumber the AI credentials migration to 0109
- fix(ai): harden key checks, Anthropic tool loops and provider isolation (budget-q8kf)
- feat(ai): AI provider layer for category suggestions (budget-q8kf)


## v2026.11.24 2026-11-24 release

### Changed

- release: v2026.11.24
- tasks: close budget-u5yt, budget-lubt, budget-mit6
- docs: transfer matcher decisions (budget-mit6)
- feat(transfers): phone layouts for the popover and payees, review polish
- feat(transfers): register suggestions, popover, review list with bulk link, payee transfer rules (client)
- feat(transfers): match transfers between own accounts, suggestions, payee transfer rules (api + contracts)
- fix(installments): no selection checkbox on derived installment rows in Scheduled
- fix(installments): phone Scheduled row stacks the purchase name over fraction and date
- feat(installments): derive upcoming card installments; skip phantom pending after anticipation
- connections: full history import with resume, 30-day daily pulls (budget-u5yt)


## v2026.11.23-04 2026-11-23 release

### Changed

- release: v2026.11.23-04
- tasks: close budget-qerr, budget-vnma
- release: split server and iOS app releases
- fix(connections): heartbeat per row during sync, 30m sync timeout, phase timings


## v2026.11.23-03 2026-11-23 release

### Changed

- release: v2026.11.23-03
- tasks: close budget-n363
- fix(migrations): 0106 without budgets FK, robust to orphan/NULL-budget/duplicate rows


## v2026.11.23-02 2026-11-23 release

### Changed

- release: v2026.11.23-02
- connections: bank-id identity is per budget; the same bank transaction imports into every budget that links it (budget-mwp0)


## v2026.11.23-01 2026-11-23 release

### Changed

- release: v2026.11.23-01
- tasks: close budget-mwp0


## v2026.11.23 2026-11-23 release

### Changed

- release: v2026.11.23
- tasks: close budget-lkor, budget-hebq, budget-1iym
- connections: bank sync is idempotent; skip bank ids already imported anywhere
- transactions: row menu in a Modal (no rail offset, above the phone FAB), back returns to the register, amount under the payee on a phone (budget-hebq)
- transactions: detail page with import info and the bank's raw data, opened from the row menu (budget-hebq)
- connections: save the raw provider payload for every bank-imported transaction (budget-lkor)


## v2026.11.22 2026-11-22 release

### Changed

- release: v2026.11.22
- tasks: close budget-wm8x, budget-fgdr, budget-vdhs, budget-bxkt
- fix(banks): Linked banks button says "Connect a bank" when no bank is listed
- fix(banks): phone layout of Linked banks, bank pages and Your Pluggy keys on iOS


## v2026.11.21-01 2026-11-21 release

### Changed

- release: v2026.11.21-01
- fix(shared): i18n rule test no longer reads it.only (bun throws under CI=true)
- docs: $values source is enabled; task release deploys with no home-systems commit
- i18n sweep: account group labels in import, payee last-used date format, keypad done key, pt-BR fixes, docs
- i18n sweep: translate admin enum labels, date hint, system names; fixes from running the app
- i18n sweep: pt-BR consistency (Encerrar, Notas, Saldo acum., gender-neutral), glossary, docs refresh, manifest READMEs
- i18n sweep: drop legacy English month/weekday tables and SHARED_LABEL, show system payee names translated
- i18n sweep: handed-over items (errors via apiErrorMessage, delete word, date format, hints, system name identity)
- i18n sweep: localize admin API errors, combobox create row, target editor and avatar errors
- i18n: one enforcement manifest for client src; localize network and bare-HTTP errors
- Fix test typing
- Translate system payee and category group names on screen (displaySystemName), search matches both names
- Translate stored bank sentences by code; route raw API error messages through apiErrorMessage
- i18n API: typed error codes with params, 44 specific codes in en/pt-BR, server-message codes, translated OAuth consent page
- i18n: import and backup features (import, backup namespaces; pt-BR; manifest import-backup)
- i18n: banks-core slice (banks + banks.keys catalogs, manifest, Pluggy widget language)
- i18n: convert home, reflect, spending, settings to catalogs (en + pt-BR)
- i18n: convert ui/ and shell/ to catalogs (ui, shell namespaces), manifest ui-shell
- i18n accounts-main: catalog (en + pt-BR), convert accounts screen, toolbar, header, modals, selection bar, reconcile
- i18n admin: catalogs (admin shell, runs, features, users) en + pt-BR, language select, rich helper, manifest
- i18n: convert features/auth and features/profile to catalogs (auth, profile.screen)
- i18n: accounts register, accountEdit and addTransaction catalogs (en + pt-BR)
- i18n core: domain, state, profile catalogs (en + pt-BR), core manifest
- i18n plan-grid: plan grid catalog (en + pt-BR), manifest, conversion of plan grid files
- i18n: payees and people catalogs (en + pt-BR), manifest payees-people
- i18n: banks bank + connect-bank slice (banks.bank, banks.connect catalogs, banks-ui manifest)
- i18n: plan mobile slice (category detail, move money, assign numpad, home) en + pt-BR
- i18n: plan inspector slice (TargetEditor, CategoryInspector, AutoAssignPanel, AssignDropdown, MonthSummary, CategoryPersonField)
- i18n: web language switch reloads, admin eslint + catalog test, CI/Taskfile, docs/i18n.md, AGENTS and architecture notes
- i18n client: locale platform, boundary, Language row, format helpers, apiErrorMessage order, catalog test, lint config
- i18n: budget-i18n/no-untranslated-string rule, manifest reader, tests
- i18n: lint fix
- i18n: shared typed t() engine, common and errors catalogs


## v2026.11.21 2026-11-21 release

### Changed

- release: v2026.11.21
- tasks: close budget-4ji, budget-id4, budget-7se, budget-fxc, budget-0dq, budget-hg2
- save
- fix(banks): paused shared-key notice no longer repeats the server's advice
- feat(banks): Your Pluggy keys screen, connect gate and paused-bank guidance
- fix(connections): review fixes for own Pluggy keys
- docs: own Pluggy keys (key sets, paused connections, CREDENTIALS_ENCRYPTION_KEY)
- feat(connections): own Pluggy keys, key set per connection, shared-key gate
- fix(repo): anchor data/ in .gitignore so EAS uploads client/src/budget/data
- backup: restore only the plan or only the register (sections)


## v2026.11.20-01 2026-11-20 release

### Changed

- release: v2026.11.20-01
- fix(brand): favicon is the bare envelope mark, no dark box
- fix(admin): features dropdown takes focus on open; tidy entry layout
- feat(features): feature groups; admin dropdown of grouped, filterable user features
- .dev
- feat(features): client useFeatures hook and admin toggles
- feat(features): typed feature list, overrides table, evaluation and admin operations


## v2026.11.20 2026-11-20 release

### Changed

- release: v2026.11.20
- chore(repo): add mise tooling config and agent guidance
- tasks
- client: password review fixes (older providers answer, token save failures, forbidden message, kept e-mail, real form on web)
- admin: readable message for 400 invalid_input (reserved e-mail)
- api: reserve password attempts before verifying, refuse reserved e-mails, review fixes
- admin: users page polish (in-flight guard, stale notice, table scroll, /me-unresolved lock, network message)
- client: e-mail + password sign-in, forced new-password step, change password in profile
- admin: Users page (list, create, edit, disable, delete, reset password) with one-time temp password dialog
- api: e-mail + password sign-in, Google linking for admin-managed users, /admin/users
- shared: password sign-in and admin user contracts, password policy
- wip
- client: rail layout with title + collapse button on top and a sectioned account menu at the bottom


## v2026.11.18-05 2026-11-18 release

### Changed

- release: v2026.11.18-05
- client: remove the settings cog next to the app switcher in the rail header
- home: taps work while the keyboard is up (iOS); iOS evidence
- docs: home page navigation and decisions; refreshed evidence
- home: caption lines, archive date, backup import owner-only, profile sign-out lands on home; evidence
- banks: a registered bank lands on /connect-bank instead of /accounts
- client: home page (my budgets, shared with me), create and invite from it; the shell no longer picks a budget; owner-only settings hidden for members
- e2e: fail the MCP run when a tool call errors
- docs: multi-user decisions (sign-in, budgets list, who can do what)
- api tests: first Access sign-in, and two people across the whole catalog
- connections: app-wide sync window is admin-only; reads follow budget access
- budget: owner or member only, no admin pass; list says owned vs shared
- api: Access sign-ins need no API allow-list; signed_in_at marks a first sign-in
- client: landing page for sign-in, explicit sign-out that stays signed out behind Access


## v2026.11.18-04 2026-11-18 release

### Changed

- release: v2026.11.18-04
- banks: regression cover for cross-budget unlink; the account's budget is a required argument
- banks: scope bank-page Unlink/Change by the account's own budget


## v2026.11.18-03 2026-11-18 release

### Changed

- release: v2026.11.18-03
- tasks: budget-hg2 ready for review
- api: build the Temporal workflow bundle into the image; worker loads it instead of bundling at boot
- ci(release): check out before the app job's first step (client/ workdir must exist)


## v2026.11.18-02 2026-11-18 release

### Changed

- release: v2026.11.18-02
- feat(settings): add settings menu to the app shell
- chore(assets): add adaptive, tinted, and dark app icons
- chore(client): add app config and asset type declarations
- chore(admin): add favicon asset
- feat(admin): add admin entry page
- chore(issues): add budget task issue report
- chore(history): record budget task history
- chore(events): record task event log
- chore(tasks): attach login flow evidence screenshots
- chore(repo): add gitattributes for consistent file handling
- client(eas): App Store Connect app id
- docs: Access sign-in (architecture, decisions + threat model, env schema, MORNING steps, stub evidence)
- client: LoginGate signs in with Cloudflare Access
- api: sign in with Cloudflare Access
- shared: GET /auth/providers contract ({ access, google })
- client(eas): pin bun 1.4.4 on EAS builders (1.4.2 fails to link zod from shared/)
- client: EAS project id
- client: eas.json and an EAS pre-install hook that installs shared/ first
- secrets: budget item holds the original Temporal password and deploy key; extra items archived
- secrets: record single-item state; new deploy key public half; drop obsolete merge script
- secrets: one 1Password item (budget) instead of three; merge script for items already created
- docs: morning list rewritten for the owner; migration-plan status; tasks: close verified phases and follow-ups
- chore(renovate): leave Expo SDK-managed minor/patch versions in client/ to expo install


## v2026.11.18-01 2026-11-18 release

### Changed

- release: v2026.11.18-01
- chore: renovate.json (RN core grouped, expo-router pinned); 1Password script: exact-title idempotency, no empty CLIENT_USER_ID, PLUGGY_SANDBOX=false, set -e safe secrets
- client: align react, gesture-handler, svg, worklets to SDK 58; declare expo-router/async-storage pins and four too-new packages in expo.install.exclude
- tasks: phase 5a/5e ready for review, follow-ups
- docs: regression pass summary in decisions
- docs: phase 5a/5e architecture, agent recipe for a client feature, decisions with metrics, regression evidence
- client(ui): replace 90 hex literals that equal a theme token with the token (white/black tokens added); values unchanged
- tasks: phase 5a/5e notes
- client: reorganise into the target layout (phase 5e)
- tasks: restore payee scope fix record
- fix(api): scope restore transfer-payee link to the budget's own accounts (budget-njc)
- tasks: phase 5c/5d records
- client: settings menu nav context in shell/menuNav; import row types in domain/importTypes (shim left for data/mapping)
- fix(client): month note follows the active budget (budget-xd6); New Budget stays on the new budget (budget-fwf)
- docs: phase 5c/5d checks, end-to-end evidence and follow-ups
- docs: note the loosened MCP output schemas
- fix(mcp): advertise output schemas with loose objects
- feat: contract outputs, contract-built requests, split budgetApi (phase 5c, G9)
- client(budget): split shell.tsx into rail/ (BudgetRail, BudgetTabs, tested section and fallback-budget logic)
- client(budget): TxnRowMenu items, card position and category list as tested pure logic; panels as components
- client(budget): split ConnectBankScreen (connect flow hook, row and widget views, tested widget-step rules)
- client(budget): PayeeDropdown view-model and placement as tested pure logic; menu body component
- client: useMoneyFormat reads a ui-level context provided from the budgetUi slice at the composition root
- client(budget): split AddTransactionSheet into addTransaction/ (keypad reducer and form rules in domain, hook, parts)
- client(budget): split InlineAddRow into useInlineAdd, panel components and tested domain rules
- client(budget): split PlanScreen into screens/plan hooks and components (behaviour-preserving)
- client(budget): plan grid logic as pure domain (filter, sections, drop target, selection, row figures) with tests
- client(budget): split ImportScreen into importFlow/ (flow reducer, hook, sections, tested logic)
- client(budget): split AccountsScreen into register hooks, child components and tested domain rules
- client(ui): one theme file (budget's tokens canonical) at ui/theme
- client(budget): split AccountEditModal into accountEdit/ (hook, sections, tested form rules)
- client(budget): split ui/MenuPanes into one file per pane under screens/settings; pane copy and list logic extracted and tested
- fix(client): Escape closes the Plan Assign dropdown (budget-ipa)
- client(budget): split ui/bits into one file per primitive under ui/primitives; draft-text rules extracted and tested
- client(budget): split ManagePayeesScreen into payees/ (hook, panes, tested logic)
- client(platform): native session token in the Keychain (expo-secure-store) with a one-time move from AsyncStorage (G22)
- feat(api,shared,client): machine-readable error code next to {error}
- docs(evidence): budget-xef fixed, number format re-renders amounts live (before/after, no reload)
- client: clear the pre-existing lint warnings outside data/ (unused imports, array types, a stale disable)
- client(budget): one definition per helper; register and Spending honour the format prefs; English UI strings


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

