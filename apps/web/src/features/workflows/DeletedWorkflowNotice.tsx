export function DeletedWorkflowNotice({onExport,onReturn}:{onExport:()=>void;onReturn:()=>void}) {
  return <section className="info" role="region" aria-label="已删除工作流" aria-live="polite">
    <strong>该工作流已删除</strong>
    <p>当前画布中的本地内容仍保留，可以复制后用新 ID 创建工作流；此流程不能再保存、校验或发布。</p>
    <p>DSL 包含已应用的配置。若输入框中还有未完成的 JSON，请同时从原输入框复制这些内容。</p>
    <div className="actions">
      <button onClick={onExport}>查看并复制本地 DSL</button>
      <button onClick={onReturn}>返回工作流库</button>
    </div>
  </section>;
}
