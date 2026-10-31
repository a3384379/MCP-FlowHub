# Discovery issue actions audit: 61e19eeca0146c2e8247c3f16720570c63115ca6

Read-only source audit; TypeScript emitted to this /tmp directory, SQLite in memory, generated home/project directories under /tmp, and only synthetic authenticated loopback MCP connected. Browser used a new isolated named Playwright CLI session and an isolated React harness importing the exact current repository components. No user browser, enterprise service, formal database, push, merge or release. All owned browser/server processes stopped; fixtures retained here.

## F1 [P1] Context update checks CAS against a derived destination, allowing another context's trust options to be overwritten

Location: packages/capability-registry/src/index.ts:30-35, especially 32-33; packages/host-discovery/src/index.ts:69; apps/web/src/features/discovery/useDiscovery.ts:201-212.

Trigger: Existing A and B both at revision 1. From A's settings, change cwd/profile to B's identity and press Update current context. UI sends A's expectedRevision but no current context ID. Server derives B's ID from submitted identity fields and validates B.revision against A's expectedRevision. B changes to revision 2 while A stays untouched. The reproduction changed B.projectTrusted false -> true and B.useAppServer true -> false. This can change the read/trust boundary of an unrelated context.

Related same-root behavior: Register a different explicit Codex path reporting the same version returns the old path without warning because context identity excludes executable path and registration returns prior unchanged. Do not count this as a separate finding.

Evidence: reproduce-context.mjs and context-evidence.json. Both CLI files were synthetic real subprocesses with identical reported versions.

Minimal fix: Separate registration from update. Update must carry immutable target context ID plus its expectedRevision and validate that exact object. Reject identity changes as re-registration, or explicitly create/select a new object without mutating a colliding existing object. When registration finds the same identity with conflicting explicit options/path, return an explicit conflict or perform an authorized CAS update; never silently ignore the chosen executable.

Regression: A/B with equal revisions; update A to B's cwd/profile must preserve B and fail or explicitly re-register. Also test unequal revisions and same-version different executable paths with distinct sentinel configuration outputs.

## F2 [P2] Credential source CAS is checked before an await, then lost updates are committed

Location: packages/capability-registry/src/index.ts:49-56 and 72.

Trigger: Two different idempotency keys configure the same source with expectedRevision=1 and different Vault references concurrently. Both read revision 1 before await resolveSource. Both transaction callbacks commit with the captured source; the second overwrites preparedConnectionId, both return success, and final source revision is only 2.

Evidence: reproduce.mjs; backend-evidence.json case concurrent-source-CAS. Both outcomes fulfilled, two distinct saved connections, final revision 2 and only the last preparedConnectionId active.

Minimal fix: After asynchronous resolution, inside repo.command's transaction re-read the source and verify expected revision, enabled/current/self state, fingerprint and context revision. Use repo.put(..., expectedRevision) as a final CAS. Do not create secrets/connections before the transaction's fresh-state validation.

Regression: Deterministically pause resolveSource in two saves. Only one may succeed and the second must return CAPABILITY_STALE/REVISION_CONFLICT; no orphan connection/secret from the rejected save. Repeat with source disabled, removed, rescanned or context changed during await.

## F3 [P2] Credential configuration accepts a source from an obsolete context revision

Location: packages/capability-registry/src/index.ts:48-51; packages/capability-registry/src/discovery-catalog.ts:339-359 and 365-391.

Trigger: Scan context revision 1, then update its read/trust options to revision 2 without scanning. Overview reports requiresScan=true but still exposes old source as actionable configuration references. configureSource checks source.revision only, not source.contextRevision against current host_contexts.revision, and writes credentials successfully to the old contextRevision=1 source.

Evidence: reproduce.mjs; backend-evidence.json case changed-context-credential-save: currentContextRevision=2, requiresScan=true, oldIssuesStillActionable=true, saveStatus=credentials_configured, sourceContextRevision=1.

Minimal fix: Require current source/context revision agreement before resolving and again at commit; optionally make old snapshot issues read-only/rescan actions when overview.current=false. Backend rejection is required even if UI hides old actions.

Regression: Scan rev1 -> change trust/profile/CLI options rev2 -> credential request with old source must reject CONTEXT_CHANGED/CAPABILITY_STALE and not create a connection or secret. After an appropriate fresh scan, the current source can configure.

## F4 [P2] Case-insensitive accepted Authorization header is not mapped to an HTTP secretRef

Location: packages/capability-registry/src/index.ts:58 and 65; classification 128-130; consuming transport packages/mcp-connectors/src/registry.ts:157-161.

Trigger: Supported env_http_headers uses AUTHORIZATION or aUtHoRiZaTiOn. Classification and validation accept it using toLowerCase(), show Configure credentials, and saving returns credentials_configured. Mapping then recognizes only Authorization and authorization and leaves HTTP connection.secretRef unset. Real subsequent directory discovery sends no Bearer token and fails authentication.

Evidence: reproduce.mjs; backend-evidence.json header-case. Real official-SDK authenticated loopback mock: Authorization -> hasSecretRef=true, ready, four tools; AUTHORIZATION and aUtHoRiZaTiOn -> hasSecretRef=false, unreachable, zero tools, AUTH_REQUIRED. No business tool calls.

Minimal fix: Normalize allowed header names once, or find the accepted authorization entry case-insensitively, and assign secretRef from its variable reference consistently. Reject conflicting duplicate case variants explicitly.

Regression: Authorization/authorization/AUTHORIZATION/mixed case all save and synchronize against an authenticated synthetic HTTP MCP; missing reference and conflicting duplicates fail explicitly without a false success.

## F5 [P2] Late registration result switches the page back to an abandoned context

Location: apps/web/src/features/discovery/useDiscovery.ts:198-218, especially 213-216.

Trigger: Start register/update A, switch context to B while POST waits, release A's response. register lacks live/epoch/active checks and calls select(A) because current active is now B. The page silently goes B -> A; the next sync or action targets A.

Evidence: exact useDiscovery hook mounted with real React in an isolated Chromium browser, deferred synthetic API. ui/main.tsx, ui-context-race.txt and .playwright-cli/page-2026-10-31T14-24-33-073Z.yml (B), .playwright-cli/page-2026-10-31T14-24-43-283Z.yml (A). Server payload and hook code are retained.

Minimal fix: Capture selection/request generation when starting registration. It may persist on server, but after await it must not select/refresh or mutate current-context UI when unmounted or selection generation changed. Track registration pending independently and prevent accidental duplicate submissions.

Regression: Delay POST and following context-list GET separately; switch A -> B, navigate away, and start another registration. Late success/error must not select A, refresh B using old intent, or show old errors in the new context.

## F6 [P2] Retained description draft is silently rebased to new source/presentation revisions

Location: apps/web/src/features/discovery/DiscoveryDetail.tsx:102, 130-131 and 149-160; drafts in DiscoveryPage.tsx:63 and 88-94 contain form values only.

Trigger: Begin editing source/description revision 1. A pending scan completes or another tab/Codex updates source/presentation; snapshot changes and Detail reloads revision 2. Old draft text is retained by entity ID, but save sends the newly loaded expectedSourceRevision=2/sourceFingerprint2/expectedPresentationRevision=2. This bypasses intended conflict detection and overwrites a newer description with text prepared for the old source.

Evidence: exact DiscoveryDetail mounted with real React in isolated Chromium; ui/main.tsx and ui-detail-rebase.txt. Old displayName=中文 r1 and summary=Edited while reviewing version one were submitted with source revision 2, fingerprint-2 and presentation revision 2. The API in this component harness captures the emitted request; server-side source/presentation CAS is thereby given apparently-current values and cannot detect the old edit baseline.

Minimal fix: Store each draft with the source fingerprint, source revision, context revision and presentation revision captured when editing starts. Preserve text on refresh, but submit its original baseline and show a conflict/source-changed state until explicitly reconciled; never silently replace baseline with latest entity metadata.

Regression: Pause a scan, begin an edit, complete scan with changed source and/or newer manual/Codex presentation, then save. Old draft remains available, newer saved text remains intact, and save conflicts. Also cover Esc -> rescan -> reopen and same-source concurrent manual edits.

## Reproduction entry points

PATH=/tmp/flowhub-v2-runtime/npm-tool/node_modules/.bin:/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin:$PATH
node /tmp/flowhub-discovery-action-audit.fyfpRP/reproduce.mjs
node /tmp/flowhub-discovery-action-audit.fyfpRP/reproduce-context.mjs
node /tmp/flowhub-discovery-action-audit.fyfpRP/build-ui.mjs
node /tmp/flowhub-discovery-action-audit.fyfpRP/serve-ui.mjs

The browser server prints an ephemeral loopback URL. Use named Playwright CLI session with cwd=/tmp/flowhub-discovery-action-audit.fyfpRP. The root URL is the hook harness; /?detail is the description harness. They import current repository source when rebuilt, so preserve this copied bundle for pre-fix evidence.
