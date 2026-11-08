# F2 independent closure

F2 is closed on marketplace source SHA-256 `5e40624453ab68ff4a193fd4476d27dd9cd4fb625d1ee9a57dbfc163ebb3d599`. The separately compiled helper SHA-256 is `351802acb213a0dde99a140740e7b39b04dc3b1adada59417ce29c1dafb96a7b` at `/tmp/flowhub-matrix-discovery-build-20261106/dist/packages/host-discovery/src/marketplace.js`.

The current source and separate compiled helper were inspected for the fix and exercised independently on the same temporary metadata fixtures. Their full components/issues results were equal in all ten cases. The probe also used the separately compiled DiscoveryCatalog with an in-memory SQLite repository and executed the current UI entityStatus function directly from source.

Observed and asserted:

- Different marketplace identities remain two entries.
- A personal AVAILABLE entry and trusted-project NOT_AVAILABLE entry with the same logical marketplace/plugin identity produce one informational, uninstalled, ambiguous candidate; both source records and both policies remain visible, both sources receive PLUGIN_MARKETPLACE_AMBIGUOUS, and coverage/status remain partial. No effective policy is guessed.
- A second-source description change and a separate policy change each advance the persisted source fingerprint, manifest hash and revision. Repeated conflicting scans and repeated identical-source scans keep their hashes/revisions stable.
- Matching source metadata clears the conflict and produces one available candidate. Conflicting candidates are excluded from the known available count; partial zero counts remain unknown.
- Installed manifest hash, description, enablement and Skill child identity remain unchanged by marketplace disagreement. The installed count stays one. Repeated installed-conflict scans are stable.
- The current UI status function labels uninstalled conflicts, enabled installed conflicts and disabled installed conflicts accurately. Detail/list source displays source-specific descriptions/policies and explicitly says precedence is undetermined. This is function/source verification, not a real-browser claim.
- The escaping-file-symlink control still reports SOURCE_UNREADABLE before parsing outside content. Historical child records retained from the preceding installed fixture are explicitly stale; they are not newly discovered candidate components.
- Connections, bindings and tool-call rows remain zero.

Command: `/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin/node artifacts/matrix-recheck-20261106/independent-audit/probe-after-marketplace-fix.mjs`.

Result: exit code 0, Node v24.19.0, darwin arm64. The marketplace source and compiled-helper hashes were rechecked after the run. No build, shared-dist mutation, fixed port, formal database, personal Codex/OAuth, model request, enterprise call or commit was used.

Evidence: `probe-after-marketplace-fix.results.json`, `probe-after-marketplace-fix.log`, `probe-after-marketplace-fix.mjs`, `probe-after-marketplace-fix.manifest.sha256.json`.

Every file in the original manifest.sha256.json still matches its original hash. The first F1/F2 counterexamples and initial audit report were preserved. Both findings from that initial independent audit now have separate successful closure records; final broad regression, rebuilt offline package, browser acceptance and external platform acceptance remain owned by their respective current receipts.
