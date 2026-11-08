# Independent audit of the matrix remediation

Baseline HEAD: `194c0b17f63846cb00d4e7fe217c80e6d342f4ed`.

Scope: the current marketplace reader and configuration IO classification, catalog/UI installation and availability projection, text-only help fallback, MCP cache instructions, and packaged runtime help. Product source was not changed. No build, broad suite, fixed-port daemon, personal Codex source, OAuth, real model, enterprise endpoint, official database, commit or push was used.

## Confirmed finding F1 — P2: an error located at tools is mistaken for lack of tool support

Locations: `packages/llm-providers/src/index.ts:49-56`, activated by the new catch at `packages/assistant-core/src/index.ts:175` and the new fallback at `packages/assistant-core/src/index.ts:371-372`.

`modelServiceFailure` classifies any non-prioritized response with `error.param === "tools"` as `MODEL_UNSUPPORTED_TOOLS`, without requiring an explicit unsupported error code or an appropriate HTTP status. The new profile probe persists this as `capabilities.tools.status = "unsupported"`. Help then omits all tools, while composition fails before another request.

An actual loopback HTTP service returned `400 {error:{code:"invalid_request_error",param:"tools",message:"Synthetic malformed tool schema"}}` whenever a request included tools. A second service returned `500 {error:{param:"tools",message:"Synthetic transient server failure"}}`. In both cases the profile became unsupported, help completed via a text-only request, and composition was blocked by `MODEL_UNSUPPORTED_TOOLS`. These responses establish a configuration/service failure, not an unsupported model. The false result is retained until another probe or identity change.

Controls: explicit `400 unsupported_parameter + param:tools` correctly falls back; `400` without a param remains failed; `401` with a tools param remains `MODEL_AUTH_FAILED` without fallback. Each case had zero workflows, tool-ledger rows and authoring-command writes.

Minimal repair: classify unsupported tools in the provider adapter only for explicit recognized unsupported codes and appropriate status. Keep malformed-schema/generic 400 and server failures as failures. Add regressions for invalid_request_error+tools, an unknown-code 400+tools, and 500+tools alongside the existing 401 and explicit unsupported controls. Do not guess a new fallback condition inside AssistantCore.

Evidence: `probe.mjs`, `probe.log`, `probe-results.json`; cases `unknown_400_tools` and `server_500_tools`.

## Reproduced source ambiguity F2 — product interpretation required

Location: `packages/host-discovery/src/marketplace.ts:51-55`.

Two different registered catalog files can declare the same catalog name and plugin name. The implementation uses only `name@catalog.name` as identity and unconditionally retains the first entry, adding only the second path to marketplaceRefs. With a personal AVAILABLE entry and a trusted-project NOT_AVAILABLE entry, the result is one AVAILABLE component, no issue, and only the personal description/policy. Changing the project policy or description leaves manifestHash unchanged. Different marketplace names correctly yield two identities.

If same-name catalogs are intended to describe a shared logical marketplace, divergent per-source metadata still needs explicit evidence and conflict handling. No personal-over-project marketplace precedence was found in the reviewed design. Preserve source-level metadata/hash or flag the conflict; do not present both references as if they jointly support the retained policy. If a deliberate precedence is adopted, state its precision in the contract and acceptance evidence. This observation does not make a candidate executable or installed.

Evidence: `probe-results.json` marketplace cases `same_market_name_conflicting_sources`, `same_market_second_source_changed`, and the distinct-identity control.

## Closed checks

- Marketplace source paths, authentication metadata and hooks are not copied into the candidate projection, followed, fetched or executed. Candidates have no executable capabilityId and are rejected by the existing import path; UI import eligibility also requires a capabilityId.
- A file symlink escaping the registered personal root produces SOURCE_UNREADABLE before JSON parsing. The existing new matrix test additionally checks escaped directory symlinks in both personal and trusted project roots, and allows in-root links. The independent probe used only temporary synthetic roots.
- Installed, available and NOT_AVAILABLE states are distinct in the catalog and UI; available-only entries do not increment the installed count. Zero in partial coverage remains unknown. Candidate components do not enter CapabilityRegistry's skill/host_tool execution projection.
- Configuration IO errors use SOURCE_UNREADABLE while TomlError uses CONFIG_PARSE_ERROR. No error message or configuration body is included in the issue.
- Help tools remain read-only. The pure-text fallback still uses the initial bounded knowledge context and citations; it does not acquire authoring tools.
- MCP cache instructions explain identity-specific tool availability and refreshing a host session without changing the fixed 7/21 collections.
- Packaging now copies DISCOVERY_LOCALIZATION.md into runtime docs, verifies runtime/source help hashes and required new JS modules, and its extracted-package smoke queries the localization help through packaged MCP. This is source review, not a claim that the final rebuilt package already passed.

## Ledger evidence precision

The discovery 24-item and assistant/UI 32-item ledgers had no missing source files, source-hash drift, absent named test literals or invalid line ranges at the audit checkpoint. The runtime 24-item draft also had matching source hashes/ranges; several name fields describe script assertions or joined stages rather than exact named tests, and this was sent to its owner for typed script-reference treatment. Counts and original FAIL/PARTIAL history were not promoted from old summaries. BASE-08 remains PARTIAL because the immutable old bootstrap increments its boot metadata on a mispointed v2 copy; the successful correct rollback does not erase that counterexample.

`ledger-consistency.json` records the literal name checks; descriptive/script names are observations for reconciliation, not missing test failures. Root's 24 authoring/MCP/testing items and the final all-suite/package receipts were still being assembled and were not assumed passed.

## Execution

Command: `/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin/node artifacts/matrix-recheck-20261106/independent-audit/probe.mjs`.

Result: exit 0, Node v24.19.0, macOS arm64. The three directly exercised product modules were transformed from current TypeScript source in memory via Node's stripTypeScriptTypes; unchanged dependencies came from root's current dist. Source/dist SHA-256 identities and method are in probe-results.json. No compilation output was written into the checkout.

The initial harness attempt tried TypeScript 7's removed transpile API and exited before any model/catalog fixture ran. Its log is retained as setup-first-attempt.log; the harness was corrected to use Node 24's built-in type transformation. This was a harness correction, not a product test failure.
