import { hash } from "../../contracts/src/domain.js";
export const V3_TABLES = [
  "discovery_entities",
  "discovery_presentations",
] as const;
const ddl =
  V3_TABLES.map(
    (table) =>
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)`,
  ).join(";") +
  ";" +
  "CREATE INDEX discovery_entity_context ON discovery_entities(json_extract(body,'$.contextId'),json_extract(body,'$.entityKind'));" +
  "CREATE INDEX discovery_presentation_entity ON discovery_presentations(json_extract(body,'$.entityId'),json_extract(body,'$.locale'),revision)";
export const V3_MIGRATION = {
  version: 3,
  ddl,
  checksum: hash(ddl),
  tables: [...V3_TABLES],
};
