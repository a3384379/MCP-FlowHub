import type {
  BusinessResult,
  BusinessRule,
  BusinessState,
  BusinessSummary,
} from "../../contracts/src/business-verification.js";
import {
  ensure,
  get,
  parts,
  type Json,
  type Node,
} from "../../contracts/src/domain.js";
import { schemaAt, validateMappedLiteral } from "./mapping-schema.js";

const outcomes = ["verified", "unavailable", "failed"] as const;

export function validateBusinessRule(rule: BusinessRule, schema?: Json) {
  parts(rule.pointer);
  if (rule.rowCountPointer !== undefined) parts(rule.rowCountPointer);
  const values = outcomes.flatMap((status) => rule[status] ?? []);
  ensure(
    new Set(values).size === values.length,
    "BUSINESS_RULE_INVALID",
    "核验结果值不能重复归类。",
  );
  if (schema) {
    for (const value of values)
      validateMappedLiteral(schema, rule.pointer, value);
    if (rule.rowCountPointer !== undefined)
      schemaAt(schema, rule.rowCountPointer);
  }
}

function readResult(output: Json, pointer: string) {
  try {
    return get(output, pointer);
  } catch {
    return undefined;
  }
}

export function classifyBusinessOutput(
  rule: BusinessRule,
  output: Json,
): BusinessResult {
  const value = readResult(output, rule.pointer);
  const state =
    outcomes.find((status) => rule[status]?.includes(value)) ?? "not_evaluated";
  const rowCount =
    state === "verified" && rule.rowCountPointer !== undefined
      ? readResult(output, rule.rowCountPointer)
      : undefined;
  return {
    state,
    ...(Number.isSafeInteger(rowCount) && rowCount >= 0 ? { rowCount } : {}),
  };
}

export function businessSummary(run: Json): BusinessSummary {
  const nodes = ((run.snapshot?.workflow?.nodes ?? []) as Node[]).flatMap(
    (node) => {
      if (!node.config?.businessVerification) return [];
      const step = run.steps?.[node.id];
      const saved = run.businessResults?.[node.id] as
        | BusinessResult
        | undefined;
      const state: BusinessState =
        step === "SKIPPED"
          ? "skipped"
          : step === "FAILED"
            ? "failed"
            : step === "OUTCOME_UNKNOWN"
              ? "unavailable"
              : step === "SUCCEEDED"
                ? (saved?.state ?? "not_evaluated")
                : [
                      "QUEUED",
                      "RUNNING",
                      "WAITING_AGENT",
                      "CANCEL_REQUESTED",
                    ].includes(run.state)
                  ? "pending"
                  : "not_evaluated";
      return [{ nodeId: node.id, title: node.title, ...saved, state }];
    },
  );
  const state =
    (
      [
        "failed",
        "unavailable",
        "pending",
        "not_evaluated",
        "verified",
        "skipped",
      ] as const
    ).find((outcome) => nodes.some((node) => node.state === outcome)) ??
    "not_evaluated";
  return { state, nodes };
}
