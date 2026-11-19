import type { workflowRequirements } from "../../../../../packages/contracts/src/workflow-requirements";

type Requirements = ReturnType<typeof workflowRequirements>;

export function ExecutionRequirements({
  requirements,
}: {
  requirements?: Requirements;
}) {
  if (!requirements) return null;
  const labels = [
    requirements.requiresCodex && "需要 Codex 接力",
    requirements.executors.includes("hub_direct") && "FlowHub 直接调用 MCP",
    requirements.executors.includes("assistant_local") && "内置助手分析",
  ].filter(Boolean);
  return (
    <p className="execution-requirements">
      {labels.join(" · ") || "FlowHub 直接执行"}
      {!!requirements.hostNodes?.length && <small>接力节点 {requirements.hostNodes.map((node) => node.title).join("、")}</small>}
      {requirements.hostSkills.length > 0 && (
        <small>宿主 Skill {requirements.hostSkills.join("、")}</small>
      )}
    </p>
  );
}

type PublicationEvidence = {
  draftRevision: number;
  structure?: string;
  mock?: { status: string };
  contract?: { status: string };
  live?: { status: string };
};

export function ExecutionEvidence({
  evidence,
  hostResult,
  synthetic,
}: {
  evidence?: PublicationEvidence;
  hostResult?: boolean;
  synthetic?: boolean;
}) {
  const statusLabels: Record<string, string> = {
    SUCCEEDED: "通过",
    PARTIAL: "部分覆盖",
    FAILED: "失败",
    STALE: "已失效",
    RUNNING: "执行中",
    QUEUED: "排队",
    CANCELLED: "已取消",
    INTERRUPTED: "已中断",
    NOT_RUN: "未执行",
  };
  const cases = [
    ["结构", evidence?.structure],
    ["Mock（合成）", evidence?.mock?.status],
    ["Contract（协议契约）", evidence?.contract?.status],
    ["Live（限定范围）", evidence?.live?.status],
  ];
  return (
    <details className="release-evidence">
      <summary>
        验证记录{evidence ? " · 发布草稿 r" + evidence.draftRevision : ""}
      </summary>
      {cases.map(([label, result]) => (
        <div key={label}>
          {label} · {result ? (statusLabels[result] ?? result) : "未记录"}
        </div>
      ))}
      <div>
        宿主交接 ·{" "}
        {hostResult
          ? synthetic
            ? "合成宿主已回传"
            : "宿主已回传，外部取证未独立核验"
          : "未实测"}
      </div>
    </details>
  );
}
