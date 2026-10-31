# Independent max re-audit of discovery fixes

Baseline: HEAD 61e19eeca0146c2e8247c3f16720570c63115ca6 plus current uncommitted discovery fixes, reviewed 2026-10-31. Repository read only. All compilation/output is in this /tmp directory; SQLite is in memory and all home/project/CLI data synthetic. Formal ports 18473/18479 and original audit evidence were not touched.

## Original findings

All six original counterexamples are closed in the reviewed source:

1. Context identity/target CAS: index.ts:37-58 now binds contextId+expectedRevision to the original object, rejects identity changes and explicit registration conflicts, and checks again after CLI resolution. Independently executed current races tests verify equal/different-revision A/B preservation, same-version explicit CLI conflict, explicit path update and partial-field preservation.
2. Credential await/CAS: index.ts:85-105 re-reads source/context inside the command transaction and performs expectedRevision CAS. Replayed original private two-save counterexample: one fulfilled, one CAPABILITY_STALE, one persisted connection, revision 2. Same-key concurrent and delayed retries also passed independently, including missing source after the first commit.
3. Obsolete context source: index.ts:74-75 rejects before resolution and 87-89 rechecks at commit; discovery-catalog overview/presentation makes old sources stale/rescan-only. Private original counterexample: requiresScan=true, oldIssuesStillActionable=false, CONTEXT_CHANGED, zero connections.
4. Authorization case: bearerCredentials() and credential mapping consistently normalize case. Original private real official-SDK authenticated loopback MCP: Authorization/AUTHORIZATION/mixed case all have secretRef, ready and four tools. Current races tests additionally cover lowercase and conflicting/missing auth without writes.
5. Late registration: useDiscovery.ts:211-245 owns results by selection/request generation. Same original exact-hook React/Chromium harness: suspend A save, select B, release A => remains B; no abandoned post-response GET/refresh. ui-context-race-fixed.txt captures request and final state.
6. Description edit baseline: DiscoveryDetail form retains context/source/presentation baseline; save uses that original baseline. Same exact-component React/Chromium harness: edit r1, refresh source/presentation r2 => notice appears and outgoing request remains expectedSourceRevision=1, fingerprint-1, expectedPresentationRevision=1. ui-detail-baseline-fixed.txt. Independently executed backend presentation suite also verifies source/presentation CAS, manual protection, batch atomicity and idempotency.

## New confirmed P2 regression: clearing form fields is silently converted to omission and overwritten by update defaults

Locations:
- apps/web/src/features/discovery/useDiscovery.ts:224-230, specifically profile: form.profile || undefined and codexPath: form.codexPath || undefined.
- packages/capability-registry/src/index.ts:43-44 (correct partial-update defaults now expose the UI's lost clear intent).
- apps/web/src/features/discovery/DiscoverySettings.tsx:54-56 and 88 (editable optional Profile and “leave blank to locate automatically” CLI field).

Trigger: Open an existing auto-mode context with profile=synthetic-profile and an explicit synthetic Codex executable. Clear both Profile and CLI inputs, then click Update current context's reading options.

Observed via real useDiscovery+DiscoverySettings, real HTTP serialization and real CapabilityRegistry with in-memory SQLite: the POST body contains neither profile nor codexPath. Backend restores both old fields from defaults, returns success, increments revision 1 -> 2, and starts a scan. UI error is empty and the old Profile/executable reappear. User's clear intent is silently ignored; a supposedly reset scan still reads the prior Profile and invokes the prior executable.

Evidence:
- ui-settings-clearing-regression.txt (DOM/controller state plus exact emitted POST body).
- settings-backend-evidence.json (real server receipts/state).
- serve-settings.mjs and ui/settings.tsx reproduce with actual source components and compiled registry, not a mocked save API.
- .playwright-cli/page-2026-10-31T14-48-16-645Z.yml before; .playwright-cli/page-2026-10-31T14-48-30-719Z.yml after.

Minimal fix: Preserve the backend rule omission=retain, target-ID binding and CAS. UI must encode explicit clears separately. Blank Profile should be explicit null and, because it changes context identity, produce typed CONTEXT_IDENTITY_CHANGED or a deliberate registration of a new context. Blank CLI needs a distinct explicit auto-location/reset intent; it must not be omitted and therefore silently retain the old executable. Do not use codexPath:null for auto mode under the current contract, where null means config_only.

Behavior regression: Existing Profile plus explicit CLI -> clear each independently -> verify either typed identity rejection preserving old object or an explicit newly registered/default-resolved context; no silent 200 with old values. Also ensure an API partial update that genuinely omits these fields continues to preserve them, and normal same-version explicit path updates remain CAS protected.

## Executed verification

- tsc -p tsconfig.json --outDir /tmp/flowhub-discovery-action-reaudit.FqHWF1/dist --sourceMap false: exit 0.
- node --test --test-concurrency=1 --test-timeout=60000 dist/tests/engine/v2-discovery-races.test.js: 15/15 pass.
- node --test --test-concurrency=1 --test-timeout=60000 dist/tests/engine/v2-discovery-presentation.test.js: 10/10 pass.
- replay-original.mjs: original header, concurrent credentials and obsolete-context private counterexamples all assert repaired behavior.
- Independent named Chromium session: both original UI counterexamples closed; new clearing regression reproduced against real registry.

## Live fixture handoff

Kept at the parent's request:
- URL: http://127.0.0.1:51098/
- PID: 3445, command `node /tmp/flowhub-discovery-action-reaudit.FqHWF1/serve-settings.mjs`.
- Stop only this fixture: `kill -TERM 3445`. Its handler closes registry/engine/SQLite, saves settings-server-evidence.json, and removes its own synthetic home/project directory.
- This process has a compiled pre-follow-up-fix backend snapshot loaded. For post-fix validation, rebuild TypeScript into this directory, rebuild UI with build-settings.mjs, and restart serve-settings.mjs (or copy the fixture to another /tmp directory). New launch prints a new ephemeral port.
- Browser session discovery-actions-max-reaudit is closed. The older component-only server on port 50844 has been stopped. No user browser was used.
