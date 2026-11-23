import { useState } from "react";

export function WorkflowSvgPreview({ svg }: { svg: string }) {
  const [actualSize, setActualSize] = useState(false);

  return (
    <>
      <div className="workflow-svg-preview-toolbar">
        <button
          type="button"
          aria-pressed={actualSize}
          onClick={() => setActualSize((current) => !current)}
        >
          原始大小
        </button>
      </div>
      <div
        className={`workflow-svg-preview${actualSize ? " actual-size" : ""}`}
        role="region"
        aria-label="流程图预览区域"
        tabIndex={actualSize ? 0 : undefined}
      >
        <img
          alt="完整流程图"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
        />
      </div>
    </>
  );
}
