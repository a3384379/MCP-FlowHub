import { useState } from "react";
import {
  businessStateLabel,
  type BusinessSummary,
} from "../../../../../packages/contracts/src/business-verification";

export function RunBusinessOutcome({
  summary,
  archived,
  detail = false,
}: {
  summary?: BusinessSummary;
  archived?: boolean;
  detail?: boolean;
}) {
  const nodes = summary?.nodes ?? [];
  const label =
    nodes.length === 1
      ? businessStateLabel(nodes[0]!)
      : businessStateLabel({ state: summary?.state ?? "not_evaluated" });
  return (
    <div className="run-business-outcome">
      <strong>业务核验 · {label}</strong>
      {archived !== undefined && (
        <small>{archived ? "报告已归档" : "暂无归档报告"}</small>
      )}
      {detail && nodes.length > 0 && (
        <ul>
          {nodes.map((result) => (
            <li key={result.nodeId}>
              {result.title} · {businessStateLabel(result)}
              {result.branch && (
                <small>
                  条件 {result.branch.conditionNodeId} 走了
                  {result.branch.selectedPort === "true" ? "满足" : "不满足"}
                  分支
                </small>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const isTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 48 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  );

type RunLocation = {
  runId: string;
  workflowName?: string;
  workflowId: string;
  version?: string;
  environment?: string;
  hostIdentityLabel?: string;
  inputs?: { from?: unknown; to?: unknown };
};

function continuationText(run: RunLocation) {
  const from = run.inputs?.from,
    to = run.inputs?.to;
  const scope =
    isTimestamp(from) && isTimestamp(to)
      ? from + " 至 " + to + "，其他范围以原运行输入为准"
      : "以原运行输入和当前检查点为准";
  return [
    "使用 FlowHub 的 flowhub-run 技能接力原运行。按当前检查点继续到报告，只在现有只读范围内取证。",
    "运行 ID " + JSON.stringify(run.runId),
    "工作流 " + JSON.stringify(run.workflowName ?? run.workflowId),
    "发布版本 " + JSON.stringify(run.version ?? "查看原运行"),
    "固定环境 " + JSON.stringify(run.environment ?? "查看原运行"),
    "范围 " + scope,
  ].join("\n");
}

export function RunContinuation({ run }: { run: RunLocation }) {
  const [receipt, setReceipt] = useState<"copied" | "manual" | null>(null);
  const text = continuationText(run);
  return (
    <>
      <p>
        在 Codex 中使用 {run.hostIdentityLabel ?? "原运行身份"}
        ，粘贴续跑指令即可继续当前检查点。
      </p>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setReceipt("copied");
          } catch {
            setReceipt("manual");
          }
        }}
      >
        复制 Codex 续跑指令
      </button>
      {receipt === "copied" && (
        <small role="status">已复制，可粘贴到 Codex。</small>
      )}
      {receipt === "manual" && (
        <label className="field">
          请复制以下续跑指令
          <textarea
            readOnly
            value={text}
            onFocus={(event) => event.currentTarget.select()}
            rows={6}
          />
        </label>
      )}
    </>
  );
}
