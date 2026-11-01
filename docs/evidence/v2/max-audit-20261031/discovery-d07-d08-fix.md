# D07 / D08 follow-up verification

Source baseline: repository HEAD 61e19eeca0146c2e8247c3f16720570c63115ca6 plus the current shared fixes. No commit, push, merge, release or formal service access.

## D07 P2: explicit clear was serialized as omission

Before: the independent max re-audit fixture showed both blank Profile and CLI missing from the request, revision incremented and the prior options silently restored. Original report remains /tmp/flowhub-discovery-action-reaudit.FqHWF1/REAUDIT.md; its evidence was not edited.

Fix: blank Profile is explicit null; blank auto-mode CLI is explicit empty string. The registry removes only an explicitly empty CLI from the merged input to request fresh automatic lookup. Omitted fields retain the target. Null CLI retains config_only. Identity changes return CONTEXT_IDENTITY_CHANGED and do not modify the original. UI preserves rejected input and explains separate registration.

After: real React useDiscovery + DiscoverySettings, serialized HTTP and current compiled CapabilityRegistry with in-memory SQLite were run at temporary port 51684. Each independent clear returned the typed error, retained blank input, and kept the original object at revision 1. Registering both clears without target ID created the default Profile with the separate synthetic automatically located CLI. Assertions and exact requests are in VERIFIED.json, profile-clear-evidence.json, cli-clear-evidence.json and new-registration-evidence.json. Named browser discovery-clear-xhigh was closed. Only synthetic directories and two synthetic Node CLIs were used.

Backend: 18/18 v2-discovery-races tests passed, including omission preservation, explicit Profile clear, different-version automatic reset, same-version automatic reset CAS and null=config_only.

## D08 P2: same-entity refresh reset credential draft and discarded a pending save receipt

Trigger before fix: switch from Skills to Issues, immediately open credential configuration, select a Vault reference and suspend the credential HTTP request. The delayed filtered catalog response changes snapshot. DiscoveryDetail treated it like navigation: cleared refs and notice, reset working, re-opened initialMode credentials and invalidated the pending action. The real backend could save while the UI showed an empty form and omitted the success receipt. Root retained the original round2 failing error-context evidence for description and credential fields pending test.

Fix: readGeneration cancels obsolete reads; generation identifies navigation/unmount and pending actions. Same-entity snapshot refresh updates data without resetting input, working or receipt. Initial credential activation runs once per navigation. Credential drafts bind their original sourceId/configuration revision, preventing refresh from silently rebasing them.

After: the pending test deterministically holds the issue catalog response until the credential save HTTP request is pending, releases catalog to force detail reload, checks the chosen reference and disabled state survive, then verifies real HTTP 200, credentials_configured receipt, persisted connection.secretRef and complete success notice. A separate source-changing scan keeps the prior credential baseline, returns 409 CAPABILITY_STALE, preserves the selected ref and creates no connection.

## Actual UI execution

A full daemon + actual built web UI ran on isolated ephemeral port 52232 with an isolated data directory, trusted synthetic CLI injection and fresh Playwright browser contexts. Production 18473 and root-owned 18479 were untouched.

- full-ui-run.log: 10 passed, 1 failed. The new baseline test fixture first tried to click the correctly disabled Issues action during scan.
- credential-baseline-run.log: the reordered fixture still failed because editing an already-loaded CLI literal did not alter that child process output.
- Fix to test fixture only: use enabled View Details then the detail credential action; have the held CLI read servers.json after barrier release.
- credential-baseline-fixed-run.log: 1 passed in 1.5s.
- full-ui-fixed-run.log: all 11 discovery browser tests passed in 8.9s, including D07/D08 and the original registration/description races.

check, build:server, build:web, TypeScript noEmit and git diff --check passed. Native Windows, real model and enterprise MCP acceptance were not performed by this subtask.

## Cleanup

Original requested fixture PID 3445 was already absent; port 51098 had no listener. The new settings fixture PID 5576 at 51684 was verified by cwd and command, then stopped gracefully. Its synthetic home/project was removed by its own handler. Named CLI browser was closed. The independent full daemon is stopped after the final run, with PID/cwd verified. Temporary artifacts remain here for root delivery.

Follow-up cleanup validation: new UI spec afterEach logs out only its own page session using GET csrf then DELETE. credential-baseline-cleanup-run.log: 1 passed in 1.9s including logout. This avoids exhausting the product's unchanged 64-session limit during the expanded full UI suite. Full daemon PID 7061 / port 52232 cwd and command were verified before graceful shutdown.

## D08 independent re-audit follow-up: reversed credential activation reads

The first D08 repair still had an uncovered activation race. Independent max evidence at /tmp/flowhub-discovery-d07-d08-reaudit.3KoGvV/d08-late-secrets-before.txt and d08-late-secrets-after.txt showed automatic GET /secrets #0 pending, later explicit activation #1 completing first, user selecting synthetic-ref, then #0 resetting it. This is retained as a real source failure, separate from the earlier fixture mistakes.

Final fix: automatic and manual activation share activateCredentialForm and a credentialActivation request generation. Success and error state writes require both current navigation and current activation ownership. Snapshot refresh does not change activation ownership; navigation and unmount do. Existing pending save receipt ownership remains unchanged.

Regression steps were added inside the existing pending-save browser test without increasing session count. The test holds both real Vault list requests, releases the manual one first, selects the real synthetic Vault ref, releases the older automatic one and waits two browser paint frames to verify it stays selected. It then continues the existing forced snapshot-while-save-pending sequence and verifies real HTTP 200, credentials_configured receipt, actual stored connection.secretRef and full success notice. credential-activation-run.log: 1 passed in 2.5s against actual rebuilt web and daemon on isolated ephemeral port 55284. check and git diff --check pass.

Final source and test freeze was reported to root and the independent max auditor. Only DiscoveryDetail and its existing UI test changed in this follow-up; backend and formal ports were untouched. The full daemon PID 12357 at 55284 was verified by cwd and command and stopped gracefully after the passing run.
