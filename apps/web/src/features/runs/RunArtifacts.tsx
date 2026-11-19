import { useEffect, useRef, useState } from "react";
import { downloadBlob } from "../../shared/download";
import { RunBusinessOutcome } from "./RunOutcome";
import type { BusinessSummary } from "../../../../../packages/contracts/src/business-verification";

type ArtifactSummary = {
  id: string;
  nodeId?: string;
  mimeType: string;
  byteLength?: number;
  expiresAt?: number;
};
type ArtifactChunk = {
  artifactId: string;
  mimeType: string;
  content: string;
  sha256: string;
  nextOffset: number;
  eof: boolean;
  verification?: {
    contentStored?: boolean;
    formatValidated?: boolean;
    evidenceReferencesValidated?: boolean;
    skillExecution?: string;
    factualReview?: string;
    businessVerification?: BusinessSummary;
  };
};
type Preview = {
  id: string;
  pending: boolean;
  chunk?: ArtifactChunk;
  error?: string;
};
type Download = {
  id: string;
  pending: boolean;
  message: string;
  error?: boolean;
};

function artifactError(error: unknown) {
  if (error instanceof Error && "status" in error && error.status === 404)
    return "附件已过期或已被清理。";
  return error instanceof Error ? error.message : "无法读取附件，请重试。";
}
function Verification({ chunk }: { chunk: ArtifactChunk }) {
  const evidence = chunk.verification;
  const skill = evidence?.skillExecution;
  return (
    <>
      <code className="artifact-hash">SHA-256：{chunk.sha256}</code>
      <dl className="verification-details">
        <dt>内容保存</dt>
        <dd>{evidence?.contentStored ? "实际内容已保存" : "未声明"}</dd>
        <dt>结构校验</dt>
        <dd>{evidence?.formatValidated ? "通过" : "未声明或未通过"}</dd>
        <dt>证据引用校验</dt>
        <dd>
          {evidence?.evidenceReferencesValidated ? "通过" : "未声明或未通过"}
        </dd>
        <dt>Skill 执行</dt>
        <dd>
          {skill === "host_reported"
            ? "宿主声明，Hub 未独立证实"
            : skill === "not_used"
              ? "未使用宿主 Skill（模板生成）"
              : (skill ?? "未声明")}
        </dd>
        <dt>事实审查</dt>
        <dd>
          {evidence?.factualReview === "human_reviewed"
            ? "已记录人工复核"
            : "未人工审查"}
        </dd>
      </dl>
      {evidence?.businessVerification && (
        <div>
          <small>报告归档时的核验结果</small>
          <RunBusinessOutcome summary={evidence.businessVerification} detail />
        </div>
      )}
      <small>
        结构与证据引用由系统校验。报告事实和 Skill 执行的核验状态见上方。
      </small>
    </>
  );
}

export function RunArtifacts({
  runId,
  artifacts,
  onPreview,
  getChunk,
  getDownload,
}: {
  runId: string;
  artifacts: ArtifactSummary[];
  onPreview: (id: string | null) => void;
  getChunk: (path: string, signal: AbortSignal) => Promise<ArtifactChunk>;
  getDownload: (path: string, signal: AbortSignal) => Promise<Response>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [download, setDownload] = useState<Download | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const previewRegion = useRef<HTMLDivElement | null>(null);
  const previewId = preview?.id;
  useEffect(
    () => () => {
      previewRequest.current?.abort();
      downloadRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (previewId) {
      previewRegion.current?.focus({ preventScroll: true });
      previewRegion.current?.scrollIntoView({ block: "nearest" });
    }
  }, [previewId]);

  const artifactPath = (artifactId: string) =>
    `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;

  async function openPreview(id: string, previous?: ArtifactChunk) {
    previewRequest.current?.abort();
    const request = new AbortController();
    previewRequest.current = request;
    if (previewId === id) previewRegion.current?.focus({ preventScroll: true });
    if (!previous) onPreview(null);
    setPreview({ id, pending: true, chunk: previous });
    try {
      const offset = previous?.nextOffset ?? 0;
      const chunk = await getChunk(
        artifactPath(id) + "?offset=" + offset + "&maxBytes=262144",
        request.signal,
      );
      if (request.signal.aborted) return;
      if (chunk?.artifactId !== id || typeof chunk.content !== "string") {
        throw new Error("附件响应格式有误，请重试。");
      }
      setPreview({
        id,
        pending: false,
        chunk: previous
          ? { ...chunk, content: previous.content + chunk.content }
          : chunk,
      });
      onPreview(id);
    } catch (error) {
      if (!request.signal.aborted)
        setPreview({
          id,
          pending: false,
          chunk: previous,
          error: artifactError(error),
        });
    }
  }

  async function saveArtifact(id: string) {
    if (downloadRequest.current) return;
    const request = new AbortController();
    downloadRequest.current = request;
    setDownload({ id, pending: true, message: "正在准备原始附件…" });
    try {
      const response = await getDownload(
        artifactPath(id) + "/download",
        request.signal,
      );
      if (response.headers.get("Content-Type") !== "application/octet-stream") {
        throw new Error("附件下载响应格式有误，请重试。");
      }
      const blob = await response.blob();
      if (request.signal.aborted) return;
      const filename =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([a-z0-9._-]+)"/i)?.[1] ??
        "flowhub-attachment.txt";
      downloadBlob(filename, blob);
      setDownload({ id, pending: false, message: "已开始下载完整附件。" });
    } catch (error) {
      if (!request.signal.aborted)
        setDownload({
          id,
          pending: false,
          message: artifactError(error),
          error: true,
        });
    } finally {
      if (downloadRequest.current === request) downloadRequest.current = null;
    }
  }

  return (
    <section className="panel">
      <h2>
        证据与报告 <small>{artifacts.length} 个</small>
      </h2>
      {!artifacts.length && <p>尚未收集到证据。</p>}
      {artifacts.map((artifact) => {
        const selected = preview?.id === artifact.id ? preview : null;
        const currentDownload = download?.id === artifact.id ? download : null;
        const expired =
          typeof artifact.expiresAt === "number" &&
          artifact.expiresAt <= Date.now();
        return (
          <div key={artifact.id}>
            <div className="artifact run-artifact">
              <span aria-hidden="true">
                {artifact.mimeType === "text/markdown" ? "▧" : "▤"}
              </span>
              <div className="run-artifact-meta">
                <strong>
                  {artifact.nodeId ?? "附件"} · {artifact.mimeType}
                </strong>
                <small>
                  {artifact.id}
                  {typeof artifact.byteLength === "number" &&
                    ` · ${artifact.byteLength} bytes`}
                </small>
                {expired && <small>附件已过期</small>}
              </div>
              <div className="run-artifact-actions">
                <button
                  disabled={expired && !selected}
                  aria-expanded={!!selected}
                  onClick={() => {
                    if (selected) {
                      previewRequest.current?.abort();
                      setPreview(null);
                      onPreview(null);
                    } else void openPreview(artifact.id);
                  }}
                >
                  {selected ? "收起查看" : "查看"}
                </button>
                <button
                  disabled={expired || download?.pending}
                  onClick={() => void saveArtifact(artifact.id)}
                >
                  下载
                </button>
              </div>
            </div>
            {currentDownload && (
              <p
                className={currentDownload.error ? "error" : undefined}
                role={currentDownload.error ? "alert" : "status"}
              >
                {currentDownload.message}
              </p>
            )}
            {selected && (
              <div
                className="evidence"
                role="region"
                aria-label="附件预览"
                tabIndex={-1}
                ref={previewRegion}
              >
                {selected.pending && <p role="status">正在读取附件…</p>}
                {selected.error && (
                  <p className="error" role="alert">
                    {selected.error}
                  </p>
                )}
                {selected.chunk && (
                  <>
                    <pre tabIndex={0}>{selected.chunk.content}</pre>
                    <Verification chunk={selected.chunk} />
                  </>
                )}
                {!selected.chunk?.eof && (selected.chunk || selected.error) && (
                  <button
                    disabled={selected.pending}
                    onClick={() =>
                      void openPreview(artifact.id, selected.chunk)
                    }
                  >
                    {selected.error ? "重试读取" : "继续读取下一块"}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
