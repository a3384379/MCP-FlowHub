import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { addFormats } from "@modelcontextprotocol/server/validators/ajv";
import { projectRoot } from "./index.js";

// JSON crosses a runtime-schema boundary before it is interpreted.
export type Json = any;
export type Workflow = {
  schemaVersion: string;
  workflowId: string;
  name: string;
  description: string;
  version: string;
  environment: string;
  mode: "guided" | "auto";
  tags: string[];
  inputSchema: Json;
  bindings: Record<string, string>;
  nodes: Node[];
  edges: { source: string; target: string; port: string }[];
  budgets: Json;
  executionRequirements?: Json;
};
export type Node = { id: string; title: string; type: string; config: Json };
export class HubError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details: Json = undefined,
  ) {
    super(message);
  }
}
export function ensure(
  ok: unknown,
  code: string,
  message: string,
  status = 422,
): asserts ok {
  if (!ok) throw new HubError(code, message, status);
}
export const id = (prefix: string) => prefix + "_" + randomUUID();
export const now = () => new Date().toISOString();
export const stable = (v: Json): string =>
  Array.isArray(v)
    ? "[" + v.map(stable).join(",") + "]"
    : v && typeof v === "object"
      ? "{" +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + stable(v[k]))
          .join(",") +
        "}"
      : JSON.stringify(v);
export const hash = (v: Json) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : stable(v))
    .digest("hex");
export const clone = <T>(v: T): T => structuredClone(v);
export const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);
export const workflowV1Schema = JSON.parse(
  readFileSync(resolve(projectRoot, "contracts/workflow.schema.json"), "utf8"),
);
export const mockSchemas = JSON.parse(
  readFileSync(
    resolve(projectRoot, "contracts/mock-results.schema.json"),
    "utf8",
  ),
);
export const workflowV2Schema = JSON.parse(readFileSync(resolve(projectRoot, "contracts/workflow-v2.schema.json"), "utf8"));
ajv.addSchema(workflowV1Schema);
ajv.addSchema(workflowV2Schema);
export const workflowSchema = { anyOf: [{ $ref: workflowV1Schema.$id }, { $ref: workflowV2Schema.$id }] };
ajv.addSchema(mockSchemas);
ajv.addSchema(
  JSON.parse(
    readFileSync(
      resolve(projectRoot, "contracts/runtime-results.schema.json"),
      "utf8",
    ),
  ),
);
const cache = new Map<string, ReturnType<typeof ajv.compile>>();
export function validate(schema: Json, value: Json) {
  const key = hash(schema);
  let fn = cache.get(key);
  if (!fn) {
    ensure(
      cache.size < 2048,
      "SCHEMA_LIMIT",
      "Schema cache capacity exceeded.",
    );
    const registered = schema.$id ? ajv.getSchema(schema.$id) : undefined;
    if (registered)
      ensure(
        hash(registered.schema) === hash(schema),
        "SCHEMA_ID_CONFLICT",
        "Schema ID collides with a different registered schema.",
      );
    fn = registered ?? ajv.compile(schema);
    cache.set(key, fn);
  }
  ensure(fn(value), "INPUT_INVALID", ajv.errorsText(fn.errors));
}
export const REPORT_HEADINGS = [
  "问题摘要",
  "环境与范围",
  "时间线",
  "日志证据",
  "数据库核对",
  "判断与置信依据",
  "尚未验证的假设",
  "建议下一步",
  "证据索引",
  "运行版本与限制",
];
export function parts(pointer: string) {
  ensure(
    pointer === "" || /^(\/([^~]|~[01])*)+$/.test(pointer),
    "MAPPING_INVALID",
    "Invalid JSON Pointer.",
  );
  const p =
    pointer === ""
      ? []
      : pointer
          .slice(1)
          .split("/")
          .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"));
  ensure(
    !p.some((x) => ["__proto__", "prototype", "constructor"].includes(x)),
    "MAPPING_INVALID",
    "Prototype paths forbidden.",
  );
  return p;
}
export function pointersOverlap(left: string, right: string) {
  const a = parts(left), b = parts(right);
  return a.slice(0, Math.min(a.length, b.length)).every((part, index) => part === b[index]);
}
export function get(value: Json, pointer: string) {
  for (const key of parts(pointer)) {
    ensure(
      value !== null && typeof value === "object" && Object.hasOwn(value, key),
      "REFERENCE_MISSING",
      "Missing reference " + pointer,
    );
    value = value[key];
  }
  return value;
}
export function set(value: Json, pointer: string, data: Json, arrayAt?: (pointer: string) => boolean) {
  const keys = parts(pointer);
  ensure(keys.length, "MAPPING_INVALID", "Destination cannot be root.");
  for (const [index, k] of keys.slice(0, -1).entries()) {
    if (Array.isArray(value))
      ensure(/^(0|[1-9]\d*)$/.test(k) && Number(k) < 10000,
        "MAPPING_INVALID", "Array destination requires a bounded index.");
    if (!Object.hasOwn(value, k))
      value[k] = (arrayAt ? arrayAt("/" + keys.slice(0, index + 1).map((key) => key.replaceAll("~", "~0").replaceAll("/", "~1")).join("/"))
        : /^(0|[1-9]\d*)$/.test(keys[index + 1]!)) ? [] : {};
    ensure(
      value[k] && typeof value[k] === "object",
      "MAPPING_INVALID",
      "Overlapping mapping.",
    );
    value = value[k];
  }
  if (Array.isArray(value))
    ensure(/^(0|[1-9]\d*)$/.test(keys.at(-1)!) && Number(keys.at(-1)) < 10000,
      "MAPPING_INVALID", "Array destination requires a bounded index.");
  value[keys.at(-1)!] = clone(data);
}
export function resolveValue(expr: Json, inputs: Json, outputs: Json): Json {
  if (Object.hasOwn(expr, "value")) return clone(expr.value);
  return clone(
    get(
      expr.ref.source === "input" ? inputs : outputs[expr.ref.nodeId],
      expr.ref.pointer,
    ),
  );
}
export function mappings(map: Json, inputs: Json, outputs: Json, arrayAt?: (pointer: string) => boolean): Json {
  const out = {};
  for (const [key, expr] of Object.entries(map ?? {}))
    set(out, key, resolveValue(expr, inputs, outputs), arrayAt);
  return out;
}
export function condition(c: Json, inputs: Json, outputs: Json): boolean {
  if (c.op === "and")
    return c.args.every((v: Json) => condition(v, inputs, outputs));
  if (c.op === "or")
    return c.args.some((v: Json) => condition(v, inputs, outputs));
  if (c.op === "not") return !condition(c.arg, inputs, outputs);
  if (c.op === "exists") {
    try {
      return resolveValue(c.value, inputs, outputs) !== undefined;
    } catch {
      return false;
    }
  }
  const a = resolveValue(c.left, inputs, outputs),
    b = resolveValue(c.right, inputs, outputs);
  if (c.op === "eq") return stable(a) === stable(b);
  if (c.op === "ne") return stable(a) !== stable(b);
  throw new HubError("CONDITION_INVALID", "Unsupported condition operation.");
}
