import { ensure, type Json } from "./domain.js";

/** A deliberately small regex language with bounded, linear backtracking.
 * No groups, alternatives, backreferences or lookarounds. Fixed repetitions
 * may coexist; at most one variable repetition is allowed. All repetition is
 * anchored to avoid searching every possible input starting position.
 */
export function assertSafePattern(pattern: unknown) {
  ensure(
    typeof pattern === "string" && pattern.length <= 512,
    "SCHEMA_INVALID",
    "Schema patterns must be strings of at most 512 characters.",
  );
  let atom = false,
    quantified = false,
    variable = 0,
    expansion = 0;
  let anchoredStart = false,
    anchoredEnd = false,
    repeated = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const escaped = pattern[++i];
      ensure(
        escaped && /[dDwWsS\\.^$|?*+()[\]{}-]/.test(escaped),
        "SCHEMA_INVALID",
        "Unsupported schema pattern escape.",
      );
      atom = true;
      quantified = false;
    } else if (ch === "[") {
      let closed = false;
      for (i++; i < pattern.length; i++) {
        if (pattern[i] === "\\") {
          const escaped = pattern[++i];
          ensure(
            escaped && /[dDwWsS\\.^$|?*+()[\]{}-]/.test(escaped),
            "SCHEMA_INVALID",
            "Unsupported character-class escape.",
          );
        } else if (pattern[i] === "]") {
          closed = true;
          break;
        } else
          ensure(
            pattern[i] !== "[",
            "SCHEMA_INVALID",
            "Nested character classes are unsupported.",
          );
      }
      ensure(
        closed,
        "SCHEMA_INVALID",
        "Unclosed schema pattern character class.",
      );
      atom = true;
      quantified = false;
    } else if (ch === "^" || ch === "$") {
      ensure(
        ch === "^" ? i === 0 : i === pattern.length - 1,
        "SCHEMA_INVALID",
        "Schema pattern anchors must be at the boundaries.",
      );
      if (ch === "^") anchoredStart = true;
      else anchoredEnd = true;
      atom = false;
      quantified = false;
    } else if (["*", "+", "?", "{"].includes(ch)) {
      repeated = true;
      ensure(
        atom && !quantified,
        "SCHEMA_INVALID",
        "Invalid or repeated schema quantifier.",
      );
      if (ch === "{") {
        const match = pattern
          .slice(i)
          .match(/^\{([0-9]{1,4})(?:,([0-9]{0,4}))?\}/);
        ensure(match, "SCHEMA_INVALID", "Unsupported schema repetition bound.");
        const minimum = Number(match[1]),
          maximum =
            match[2] === undefined
              ? minimum
              : match[2] === ""
                ? Infinity
                : Number(match[2]);
        ensure(
          minimum <= 4096 &&
            maximum >= minimum &&
            (maximum === Infinity || maximum <= 4096),
          "SCHEMA_INVALID",
          "Schema repetition exceeds limits.",
        );
        if (minimum !== maximum) variable++;
        else expansion += minimum;
        i += match[0].length - 1;
      } else variable++;
      ensure(
        variable <= 1 && expansion <= 4096,
        "SCHEMA_INVALID",
        "Schema patterns permit at most one variable repetition and 4096 fixed repetitions.",
      );
      quantified = true;
    } else {
      ensure(
        !["(", ")", "|", "]", "}"].includes(ch),
        "SCHEMA_INVALID",
        "Schema pattern groups and alternatives are unsupported.",
      );
      atom = true;
      quantified = false;
    }
  }
  ensure(
    !repeated || (anchoredStart && anchoredEnd),
    "SCHEMA_INVALID",
    "Schema repetitions require start and end anchors.",
  );
  try {
    new RegExp(pattern, "u");
  } catch {
    ensure(false, "SCHEMA_INVALID", "Invalid schema pattern.");
  }
}

type SchemaWalkOptions = { maxDepth?: number; maxNodes?: number };
const schemaMaps = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
];
const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"];
const singleSchemas = [
  "additionalProperties",
  "unevaluatedProperties",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];

/** Visit only JSON Schema positions; property dictionaries and literal data
 * are not schemas. Resource limits still account for the entire JSON document,
 * including annotation/default/const/enum/example data, before any evaluation.
 */
export function walkSchema(
  schema: Json,
  visitor: (schema: Json, depth: number) => void,
  { maxDepth = 24, maxNodes = 2048 }: SchemaWalkOptions = {},
) {
  const json: { value: Json; depth: number }[] = [{ value: schema, depth: 0 }];
  let nodes = 0;
  while (json.length) {
    const { value, depth } = json.pop()!;
    ensure(
      depth <= maxDepth && ++nodes <= maxNodes,
      "SCHEMA_LIMIT",
      "Schema exceeds nesting or node limits.",
    );
    if (value && typeof value === "object")
      for (const child of Object.values(value)) {
        ensure(
          nodes + json.length < maxNodes,
          "SCHEMA_LIMIT",
          "Schema exceeds node limits.",
        );
        json.push({ value: child, depth: depth + 1 });
      }
  }
  ensure(
    Buffer.byteLength(JSON.stringify(schema) ?? "") <= 131072,
    "SCHEMA_LIMIT",
    "Schema exceeds 128 KiB.",
  );
  const schemas = [{ value: schema, depth: 0 }];
  while (schemas.length) {
    const { value, depth } = schemas.pop()!;
    ensure(
      typeof value === "boolean" ||
        (value && typeof value === "object" && !Array.isArray(value)),
      "SCHEMA_INVALID",
      "A schema must be an object or boolean.",
    );
    visitor(value, depth);
    if (typeof value === "boolean") continue;
    const add = (child: Json) =>
      schemas.push({ value: child, depth: depth + 1 });
    for (const keyword of schemaMaps)
      if (Object.hasOwn(value, keyword)) {
        const map = value[keyword];
        ensure(
          map && typeof map === "object" && !Array.isArray(map),
          "SCHEMA_INVALID",
          "Schema map must be an object.",
        );
        for (const child of Object.values(map)) add(child);
      }
    for (const keyword of schemaArrays)
      if (Object.hasOwn(value, keyword)) {
        ensure(
          Array.isArray(value[keyword]),
          "SCHEMA_INVALID",
          "Schema combination must be an array.",
        );
        for (const child of value[keyword]) add(child);
      }
    for (const keyword of singleSchemas)
      if (Object.hasOwn(value, keyword)) add(value[keyword]);
    if (Object.hasOwn(value, "items")) {
      // Inspect legacy tuple schemas too, even when a later dialect validator
      // rejects that form. Dependency arrays contain names rather than schemas.
      for (const child of Array.isArray(value.items)
        ? value.items
        : [value.items])
        add(child);
    }
    if (Object.hasOwn(value, "dependencies")) {
      const dependencies = value.dependencies;
      ensure(
        dependencies &&
          typeof dependencies === "object" &&
          !Array.isArray(dependencies),
        "SCHEMA_INVALID",
        "Schema dependencies must be an object.",
      );
      for (const child of Object.values(dependencies))
        if (!Array.isArray(child)) add(child);
    }
  }
}

export function assertSafeSchemaPatterns(schema: Json) {
  walkSchema(schema, (node) => {
    if (typeof node === "boolean") return;
    if (Object.hasOwn(node, "pattern")) assertSafePattern(node.pattern);
    for (const pattern of Object.keys(node.patternProperties ?? {}))
      assertSafePattern(pattern);
  });
}
