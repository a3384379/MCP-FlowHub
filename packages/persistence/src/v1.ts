// Frozen from main@45eed03. Never change these bytes or table order.
export const V1_TABLES = [
  "settings",
  "connections",
  "bindings",
  "workflows",
  "versions",
  "runs",
  "artifacts",
  "approvals",
  "secrets",
  "attempts",
  "clients",
] as const;
export const V1_REPOSITORY_DDL = V1_TABLES.map(
  (t) =>
    "CREATE TABLE IF NOT EXISTS " +
    t +
    " (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)",
).join(";");
export const V1_JOURNAL_DDL =
  "CREATE TABLE IF NOT EXISTS commands(owner TEXT,operation TEXT,key TEXT,request_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(owner,operation,key)); CREATE TABLE IF NOT EXISTS run_events(run_id TEXT,seq INTEGER,body TEXT NOT NULL,PRIMARY KEY(run_id,seq)); CREATE TABLE IF NOT EXISTS audit_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL)";
