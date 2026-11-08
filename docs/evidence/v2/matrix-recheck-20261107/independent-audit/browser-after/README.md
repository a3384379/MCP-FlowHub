# F2 real-browser follow-up

The final replayable browser probe passed with exit code 0 on Node v24.19.0 / darwin arm64. It used the current dist/web-dist, an owned port-0 daemon on port 50243, a fresh temporary SQLite data directory, synthetic personal/trusted-project catalogs, an owned FakeCodex CLI and one isolated headless Playwright Chromium context. It did not use a personal browser profile, personal Codex home/OAuth, model profile, model-message request, enterprise service or business run.

Command:

```sh
/tmp/flowhub-v2-runtime/node-v24.19.0-darwin-arm64/bin/node artifacts/matrix-recheck-20261106/independent-audit/browser-after/probe.mjs
```

The real rendered page and API jointly established:

1. A shared-market/plugin identity with personal AVAILABLE and trusted-project NOT_AVAILABLE policies has an uninstalled conflict card. Both catalog source paths, descriptions and policies appear in its detail; the page does not assign precedence.
2. The candidate remains informational/ambiguous and is excluded from the known available count. An independently installed disabled plugin remains counted as installed and retains its actual manifest description and Skill child.
3. After the fixture's project catalog is changed to match the personal catalog, clicking the actual page's rescan button clears both conflicts. The page shows complete coverage, one installed plugin and one available uninstalled candidate.
4. The installed manifest hash, disabled state, description, version and Skill capability identity stay equal across the rescan. Reloading the page retains the resolved state.
5. The uninstalled candidate's Skill and hook are not indexed/executed. Model profiles are empty, browser external requests are zero, and allowed browser writes are discovery scans plus the shell's empty assistant-session creation; there are no inference-message, self-test or business-run dispatches.

`receipt.json` records source/runtime hashes before execution and confirms they were unchanged afterward, API observations, request method/path inventory, screenshots, snapshots and cleanup. The Chromium context was closed, the owned daemon stopped normally with exit 0, and the temporary data directory was removed. Root's shared ports 18473/18479 were not used.

Five final screenshots and seven ARIA snapshots are present. `03-candidate-conflict-detail.png` and `05-resolved-cards.png` were also visually inspected. These supplement the earlier function/backend closure; they do not replace root's complete UI suite or external real-model/Windows acceptance.

The first two probe attempts are preserved separately and are not counted as passes:

- `first-attempt/`: the artifact script's close-button selector matched both header and footer controls. It stopped after displaying the conflict cards and candidate detail; its owned resources were cleaned up.
- `second-attempt/`: the full F2 UI chain completed, but an extra harness assertion incorrectly rejected shell GET list requests and creation of an empty assistant session. The final script restricts writes to the two allowed non-inference endpoints instead. Its owned resources were also cleaned up.

Only ignored artifact scripts/evidence were adjusted between attempts. Product source, indexed help and repository test files were not modified by this probe. The original independent audit and first F1/F2 counterexamples remain untouched.
