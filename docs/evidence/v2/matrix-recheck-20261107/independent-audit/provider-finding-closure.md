# F1 independent closure

F1 is closed on Provider source SHA-256 `c0be7e0d5e90d62a5423d75139db23f8487998c79042d17435180f13232f0504`.

The Provider now requires HTTP 400, a tools parameter, and an explicit unsupported_parameter/unsupported_value code for MODEL_UNSUPPORTED_TOOLS. AssistantCore was not changed during this fix.

The independent original five-case HTTP probe was rerun against current source transformed in memory, with strict expected-result assertions. Exit code 0 on Node v24.19.0 / darwin arm64:

| Original case | Tool probe | Help | Tools sent in help |
|---|---|---|---|
| Explicit unsupported 400 | unsupported | COMPLETED | no |
| invalid_request_error 400 at tools | failed / MODEL_INVALID_CONFIGURATION | FAILED | yes |
| Unknown 400 without param | failed / MODEL_INVALID_CONFIGURATION | FAILED | yes |
| Authentication 401 at tools | failed / MODEL_AUTH_FAILED | FAILED | yes |
| Server 500 at tools | failed / MODEL_REQUEST_FAILED | FAILED | yes |

All five retained zero workflows, tool-ledger rows and authoring-command writes. The Provider source hash was checked before the run and again after it. No shared build, fixed port, official data, personal Codex/OAuth, real model or enterprise endpoint was used.

Command: `/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin/node artifacts/matrix-recheck-20261106/independent-audit/probe-after-provider-fix.mjs`.

Evidence: `probe-after-provider-fix.results.json`, `probe-after-provider-fix.log`, `probe-after-provider-fix.mjs`, `probe-after-provider-fix.manifest.sha256.json`.

Every file in the original manifest.sha256.json was rechecked and remained unchanged, including the first counterexample results/log and original audit report. The new evidence supersedes F1's open status; F2's marketplace source ambiguity is separate.
