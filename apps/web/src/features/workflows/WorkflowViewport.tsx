import { useEffect, useRef } from "react";
import {
  Panel,
  getViewportForBounds,
  useNodesInitialized,
  useReactFlow,
  useStore,
} from "@xyflow/react";

export const minimumWorkflowZoom = 0.01;
const readingZoom = 0.9;

export function WorkflowViewport({ entryId }: { entryId?: string }) {
  const flow = useReactFlow();
  const ready = useNodesInitialized();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const percent = useStore((state) => Math.round(state.transform[2] * 100));
  const lastSize = useRef<{ width: number; height: number } | null>(null);
  const overview = () =>
    getViewportForBounds(
      flow.getNodesBounds(flow.getNodes()),
      width,
      height,
      minimumWorkflowZoom,
      1.2,
      "36px",
    );
  const locateEntry = () => {
    const entry =
      (entryId ? flow.getNode(entryId) : undefined) ?? flow.getNodes()[0];
    if (!entry) return;
    const bounds = flow.getNodesBounds([entry]);
    void flow.setCenter(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      {
        zoom: readingZoom,
      },
    );
  };

  useEffect(() => {
    if (!ready || !flow.viewportInitialized || !width || !height) return;
    const previous = lastSize.current;
    if (previous?.width === width && previous.height === height) return;
    lastSize.current = { width, height };
    if (!previous) {
      const initial = overview();
      if (initial.zoom >= 0.72) void flow.setViewport(initial);
      else locateEntry();
      return;
    }
    // Preserve the point at the center when the window or docked panels resize.
    const { x, y, zoom } = flow.getViewport();
    void flow.setViewport({
      x: x + (width - previous.width) / 2,
      y: y + (height - previous.height) / 2,
      zoom,
    });
  }, [ready, flow, width, height, entryId]);

  return (
    <Panel className="workflow-view-controls" position="top-left">
      <button disabled={!ready} onClick={locateEntry}>
        定位起点
      </button>
      <button
        disabled={!ready}
        onClick={() => void flow.setViewport(overview())}
      >
        查看全图
      </button>
      <span className="workflow-zoom">缩放 {percent}%</span>
    </Panel>
  );
}
