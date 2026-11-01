import { ensure, get, type Json } from "./domain.js";

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

/** Native host contracts keep their JSON Schema meaning, including open objects.
 * References may only reach schema positions in this document. Both the source
 * tree and its acyclic reference expansion are bounded before AJV sees them.
 */
export function assertSafeNativeObjectSchema(root: Json) {
  const positions=new Set<Json>(),references=new Map<Json,Json>();
  walkSchema(root,node=>{
    positions.add(node);
    if(typeof node==="boolean")return;
    ensure(!Object.hasOwn(node,"$id")&&!Object.hasOwn(node,"$anchor")&&!Object.hasOwn(node,"$dynamicAnchor")&&!Object.hasOwn(node,"$dynamicRef")&&!Object.hasOwn(node,"$recursiveRef"),
      "SCHEMA_INVALID","Native contracts cannot change reference scope or use dynamic references.");
    if(Object.hasOwn(node,"$ref")) {
      ensure(typeof node.$ref==="string"&&node.$ref.startsWith("#/")&&node.$ref.length<=512,"SCHEMA_INVALID","Only document-local JSON Pointer references are supported.");
      let target:Json;
      try{target=get(root,decodeURIComponent(node.$ref.slice(1)));}catch{ensure(false,"SCHEMA_INVALID","Local schema reference is missing or invalid.");}
      references.set(node,target);
    }
  },{maxDepth:15,maxNodes:2048});
  assertSafeSchemaPatterns(root);
  for(const target of references.values())ensure(positions.has(target),"SCHEMA_INVALID","References must target a schema position in the native document.");
  const children=(node:Json):Json[]=>{
    if(typeof node==="boolean")return [];
    const result:Json[]=[];
    for(const keyword of schemaMaps)if(Object.hasOwn(node,keyword))result.push(...Object.values(node[keyword]));
    for(const keyword of schemaArrays)if(Object.hasOwn(node,keyword))result.push(...node[keyword]);
    for(const keyword of singleSchemas)if(Object.hasOwn(node,keyword))result.push(node[keyword]);
    if(Object.hasOwn(node,"items"))result.push(...(Array.isArray(node.items)?node.items:[node.items]));
    if(node.dependencies)result.push(...Object.values(node.dependencies).filter(value=>!Array.isArray(value)));
    if(references.has(node))result.push(references.get(node));
    return result;
  };
  const active=new Set<Json>(),memo=new Map<Json,{depth:number;nodes:number}>();
  const expand=(node:Json):{depth:number;nodes:number}=>{
    ensure(!active.has(node),"SCHEMA_INVALID","Recursive native schema references are unsupported.");
    const prior=memo.get(node);if(prior)return prior;
    active.add(node);let depth=1,nodes=1;
    for(const child of children(node)){const expanded=expand(child);depth=Math.max(depth,expanded.depth+1);nodes+=expanded.nodes;
      ensure(depth<=24&&nodes<=8192,"SCHEMA_LIMIT","Native schema reference expansion exceeds limits.");}
    active.delete(node);const result={depth,nodes};memo.set(node,result);return result;
  };
  expand(root);
  let object=root;
  while(object&&object.type===undefined&&references.has(object))object=references.get(object);
  ensure(object?.type==="object","SCHEMA_INVALID","Native host output must have an object root.");
}
