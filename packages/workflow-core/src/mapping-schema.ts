import { ensure, get, parts, validate, type Json } from "../../contracts/src/domain.js";

// Downstream catalogs may use local definitions. Every lookup retains its root
// document; a property schema is never compiled as a detached document.
function dereference(schema: Json, root: Json, seen: string[] = []): Json {
  if (!schema?.$ref) return schema;
  ensure(typeof schema.$ref === "string" && schema.$ref.startsWith("#/"),
    "SCHEMA_INVALID", "Only local schema references are supported.");
  ensure(!seen.includes(schema.$ref) && seen.length < 24,
    "SCHEMA_INVALID", "Recursive schema references are unsupported.");
  let target: Json;
  try { target = get(root, schema.$ref.slice(1)); }
  catch { ensure(false, "SCHEMA_INVALID", "Local schema reference is missing."); }
  return { ...dereference(target, root, [...seen, schema.$ref]),
    ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref")) };
}

export function schemaAt(root: Json, pointer: string, requirePresent = false): Json {
  let schema = dereference(root, root);
  for (const key of parts(pointer)) {
    ensure(schema && typeof schema === "object", "REFERENCE_INVALID", "Reference schema missing.");
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (requirePresent)
      ensure(!types.some((type: Json) => type && !["array", "object"].includes(type)),
        "REFERENCE_OPTIONAL", "Reference parent can be absent or scalar.");
    if (types.includes("array")) {
      ensure(/^(0|[1-9]\d*)$/.test(key) && Number(key) < 10000,
        "REFERENCE_INVALID", "Array reference requires a bounded index.");
      if (requirePresent)
        ensure((schema.minItems ?? 0) > Number(key), "REFERENCE_OPTIONAL",
          "Reference array item is not guaranteed to exist.");
      schema = schema.prefixItems?.[Number(key)] ?? schema.items;
    } else {
      if (requirePresent)
        ensure(schema.required?.includes(key), "REFERENCE_OPTIONAL",
          "Reference field is optional; use an exists condition instead.");
      schema = schema.properties?.[key];
    }
    ensure(schema !== undefined, "REFERENCE_INVALID", "Reference field not declared.");
    schema = dereference(schema, root);
  }
  ensure(schema !== undefined, "REFERENCE_INVALID", "Reference schema missing.");
  return schema;
}

function standalone(schema: Json, root: Json, depth = 0, references: string[] = []): Json {
  ensure(depth < 32, "SCHEMA_LIMIT", "Schema reference expansion too deep.");
  if (schema?.$ref) {
    ensure(!references.includes(schema.$ref), "SCHEMA_INVALID", "Recursive schema references are unsupported.");
    references = [...references, schema.$ref];
  }
  schema = dereference(schema, root);
  if (!schema || typeof schema !== "object") return schema;
  const result: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["$id", "$defs", "definitions"].includes(key)) continue;
    if (["properties", "patternProperties", "dependentSchemas"].includes(key))
      result[key] = Object.fromEntries(Object.entries(value as Json).map(([name, child]) =>
        [name, standalone(child, root, depth + 1, references)]));
    else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key))
      result[key] = (value as Json[]).map((child) => standalone(child, root, depth + 1, references));
    else if (["items", "contains", "propertyNames", "additionalProperties", "unevaluatedProperties",
      "unevaluatedItems", "not", "if", "then", "else", "contentSchema"].includes(key))
      result[key] = standalone(value, root, depth + 1, references);
    // const, enum, examples and annotations are inert JSON, including `$ref` keys.
    else result[key] = value;
  }
  return result;
}

export function validateMappedLiteral(root: Json, pointer: string, value: Json) {
  validate(standalone(schemaAt(root, pointer), root), value);
}

export function assertAssignable(source: Json, sourceRoot: Json, target: Json,
  targetRoot: Json, path: string, depth = 0) {
  ensure(depth < 24, "SCHEMA_LIMIT", "Mapping schema nesting too deep.");
  source = dereference(source, sourceRoot); target = dereference(target, targetRoot);
  const types = (schema: Json): string[] => schema?.type
    ? Array.isArray(schema.type) ? schema.type : [schema.type] : [];
  const from = types(source), to = types(target);
  ensure(!to.length || (from.length && from.every((type) =>
    to.includes(type) || (type === "integer" && to.includes("number")))),
    "TYPE_MISMATCH", "Mapping type mismatch at " + path);
  if (from.includes("object") && (to.includes("object") || !to.length)) {
    for (const key of target.required ?? [])
      ensure(source.required?.includes(key), "MAPPING_INVALID",
        "Source object does not guarantee required field at " + path + "/" + key);
    for (const [key, child] of Object.entries(source.properties ?? {})) {
      const destination = target.properties?.[key];
      ensure(destination !== undefined || target.additionalProperties !== false,
        "TYPE_MISMATCH", "Source object contains an undeclared target field at " + path + "/" + key);
      if (destination !== undefined)
        assertAssignable(child, sourceRoot, destination, targetRoot, path + "/" + key, depth + 1);
    }
  }
  if (from.includes("array") && (to.includes("array") || !to.length) && target.items && source.items)
    assertAssignable(source.items, sourceRoot, target.items, targetRoot, path + "/0", depth + 1);
}
