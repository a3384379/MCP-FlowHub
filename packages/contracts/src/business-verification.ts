type Outcome = string | number | boolean | null;

export type BusinessRule = {
  pointer: string;
  verified: Outcome[];
  unavailable?: Outcome[];
  failed?: Outcome[];
  rowCountPointer?: string;
};

export type BusinessState =
  | "verified"
  | "unavailable"
  | "failed"
  | "skipped"
  | "pending"
  | "not_evaluated";
export type BusinessResult = {
  state: BusinessState;
  rowCount?: number;
  branch?: { conditionNodeId: string; selectedPort: "true" | "false" };
};

export type BusinessSummary = {
  state: BusinessState;
  nodes: (BusinessResult & { nodeId: string; title: string })[];
};

const stateLabels: Record<BusinessState, string> = {
  verified: "核验完成",
  unavailable: "未核验",
  failed: "核验失败",
  skipped: "按流程跳过",
  pending: "待核验",
  not_evaluated: "未评估",
};

export function businessStateLabel(result: BusinessResult) {
  if (result.state === "verified" && result.rowCount !== undefined)
    return "查询成功 · " + result.rowCount + " 行";
  return stateLabels[result.state];
}
