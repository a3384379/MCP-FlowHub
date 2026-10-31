import { Icon, issueLabels } from "./shared";
import { issueAction, type Issue } from "./issue-actions";

export function DiscoveryIssues({
  issues,
  query,
  busy,
  scanned,
  onAction,
  onDetail,
  onSettings,
  onGuide,
}: {
  issues: Issue[];
  query: string;
  busy: boolean;
  scanned: boolean;
  onAction: (issue: Issue) => void;
  onDetail: (id: string) => void;
  onSettings: () => void;
  onGuide: (issue: Issue) => void;
}) {
  const visible = issues.filter((i) =>
    [i.name, i.displayName, i.code, issueLabels[i.code], i.source]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="d-issues">
      {visible.map((issue, index) => {
        const action = issueAction(issue);
        return (
          <article
            className="d-issue"
            key={[
              issue.entityId,
              issue.sourceId,
              issue.source,
              issue.code,
              index,
            ].join(":")}
          >
            <Icon name="issue" />
            <div className="d-issue-body">
              <h3>
                {issue.displayName ||
                  issue.name ||
                  issueLabels[issue.code] ||
                  "来源需要处理"}
              </h3>
              <p>{issueLabels[issue.code] ?? issue.code}</p>
              <p className="d-issue-help">{action.help}</p>
              <details>
                <summary>查看来源与诊断代码</summary>
                <code>{issue.code}</code>
                <p>{issue.source || issue.sourceId || "当前本机上下文"}</p>
              </details>
            </div>
            <div className="d-issue-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => onAction(issue)}
              >
                {action.label}
              </button>
              {["connection", "credentials", "sync"].includes(action.type) && (
                <button onClick={() => onGuide(issue)}>处理说明</button>
              )}
              {action.type === "sync" && (
                <button
                  disabled={busy}
                  onClick={() => onAction({ ...issue, code: "unsupported" })}
                >
                  手动连接
                </button>
              )}
              {issue.entityId ? (
                <button onClick={() => onDetail(issue.entityId)}>
                  查看详情
                </button>
              ) : (
                action.type !== "settings" && (
                  <button onClick={onSettings}>发现设置</button>
                )
              )}
            </div>
          </article>
        );
      })}
      {!visible.length && (
        <div className="d-empty">
          {issues.length
            ? "没有匹配的问题，试试其他名称或诊断代码。"
            : scanned
              ? "当前快照没有需要处理的问题。"
              : "尚未扫描，问题数量未知。"}
        </div>
      )}
    </div>
  );
}
