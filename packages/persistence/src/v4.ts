import { hash } from "../../contracts/src/domain.js";

// JSON1 limits nesting more strictly than JSON.parse. The numeric key holds only
// exceptional documents; real run IDs are strings. The reader checks that bucket in JS.
export const V4_HISTORY_RUN_KEY = "CASE WHEN json_valid(body) THEN json_extract(body,'$.runId') ELSE 0 END";
export const V4_ACTIVE_RUN_FILTER = "CASE WHEN json_valid(body) THEN coalesce(json_extract(body,'$.state'),'') NOT IN ('SUCCEEDED','FAILED','REJECTED','CANCELLED','OUTCOME_UNKNOWN') ELSE 1 END";
const ddl = [
  "CREATE INDEX attempts_by_run ON attempts(" + V4_HISTORY_RUN_KEY + ")",
  "CREATE INDEX artifacts_by_run ON artifacts(" + V4_HISTORY_RUN_KEY + ")",
  "CREATE INDEX active_runs ON runs(json_valid(body)) WHERE " + V4_ACTIVE_RUN_FILTER,
].join(";");

export const V4_MIGRATION = { version: 4, ddl, checksum: hash(ddl), tables: [] };
