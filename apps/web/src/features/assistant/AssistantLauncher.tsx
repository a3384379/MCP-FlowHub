import { useEffect, useRef, useState, type RefObject } from "react";

type Placement = { side: "left" | "right"; ratio: number; docked: boolean };
const storageKey = "flowhub.assistant.launcher.v1";
const initial = (): Placement => {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (
      value &&
      ["left", "right"].includes(value.side) &&
      typeof value.ratio === "number" &&
      Number.isFinite(value.ratio) &&
      value.ratio >= 0 &&
      value.ratio <= 1 &&
      typeof value.docked === "boolean"
    )
      return value;
  } catch {
    /* A blocked store must not hide the assistant. */
  }
  return { side: "right", ratio: 0.72, docked: false };
};
const bounds = () => {
  const v = window.visualViewport;
  return {
    left: v?.offsetLeft ?? 0,
    top: v?.offsetTop ?? 0,
    width: v?.width ?? innerWidth,
    height: v?.height ?? innerHeight,
  };
};
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(Math.max(min, max), value));

export function AssistantLauncher({
  launcherRef,
  opened,
  unread,
  toggle,
  onSideChange,
}: {
  launcherRef: RefObject<HTMLButtonElement | null>;
  opened: boolean;
  unread: boolean;
  toggle: () => void;
  onSideChange: (side: "left" | "right") => void;
}) {
  const [placement, setPlacement] = useState(initial),
    [viewport, setViewport] = useState(bounds),
    [moving, setMoving] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{
      id: number;
      x: number;
      y: number;
      left: number;
      top: number;
      moved: boolean;
    } | null>(null),
    suppressClick = useRef(false);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(placement));
    } catch {
      /* Position still works in memory. */
    }
  }, [placement]);
  useEffect(() => {
    onSideChange(placement.side);
  }, [placement.side, onSideChange]);
  useEffect(() => {
    const update = () => setViewport(bounds());
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  const width = placement.docked ? 22 : 54,
    height = placement.docked ? 64 : 54,
    minTop = viewport.top + 16,
    travel = Math.max(0, viewport.height - height - 32),
    top = moving?.top ?? minTop + travel * placement.ratio,
    left =
      moving?.left ??
      (placement.side === "left"
        ? viewport.left + (placement.docked ? 0 : 12)
        : viewport.left + viewport.width - width - (placement.docked ? 0 : 12));
  const cancelDrag = () => {
    drag.current = null;
    setMoving(null);
  };
  return (
    <div
      className={
        "assistant-launcher-position " +
        (placement.docked ? "is-docked " : "") +
        (moving ? "is-dragging" : "")
      }
      data-side={placement.side}
      data-open={opened}
      style={{ left, top }}
    >
      <button
        ref={launcherRef}
        className="assistant-launcher"
        aria-label={opened ? "收起 FlowHub 助手" : "打开 FlowHub 助手"}
        aria-expanded={opened}
        aria-controls="flowhub-assistant-window"
        aria-describedby="assistant-position-help"
        title="可拖动调整位置；方向键移动；小箭头可贴边收起或展开图标"
        onPointerDown={(e) => {
          if (!e.isPrimary || e.button !== 0) return;
          suppressClick.current = false;
          const r = e.currentTarget.parentElement!.getBoundingClientRect();
          drag.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            left: r.left,
            top: r.top,
            moved: false,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const start = drag.current;
          if (!start || start.id !== e.pointerId) return;
          const dx = e.clientX - start.x,
            dy = e.clientY - start.y;
          if (!start.moved && Math.hypot(dx, dy) < 6) return;
          start.moved = true;
          setMoving({
            left: clamp(
              start.left + dx,
              viewport.left,
              viewport.left + viewport.width - width,
            ),
            top: clamp(start.top + dy, minTop, minTop + travel),
          });
        }}
        onPointerUp={(e) => {
          const start = drag.current;
          if (!start || start.id !== e.pointerId) return;
          if (start.moved) {
            const nextLeft = clamp(
                start.left + e.clientX - start.x,
                viewport.left,
                viewport.left + viewport.width - width,
              ),
              nextTop = clamp(
                start.top + e.clientY - start.y,
                minTop,
                minTop + travel,
              );
            setPlacement((p) => ({
              ...p,
              side:
                nextLeft + width / 2 < viewport.left + viewport.width / 2
                  ? "left"
                  : "right",
              ratio: travel ? (nextTop - minTop) / travel : 0,
            }));
            suppressClick.current = true;
          }
          cancelDrag();
        }}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
        onKeyDown={(e) => {
          if (
            ![
              "ArrowUp",
              "ArrowDown",
              "ArrowLeft",
              "ArrowRight",
              "Escape",
            ].includes(e.key)
          )
            return;
          e.preventDefault();
          setPlacement((p) => ({
            ...p,
            ...(e.key === "Escape"
              ? { docked: true }
              : e.key === "ArrowLeft"
                ? { side: "left" }
                : e.key === "ArrowRight"
                  ? { side: "right" }
                  : {
                      ratio: clamp(
                        p.ratio + (e.key === "ArrowUp" ? -0.05 : 0.05),
                        0,
                        1,
                      ),
                    }),
          }));
        }}
        onClick={(e) => {
          if (suppressClick.current && e.detail !== 0) {
            suppressClick.current = false;
            e.preventDefault();
            return;
          }
          suppressClick.current = false;
          toggle();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m12 3 2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3Z" />
        </svg>
        {unread && !opened && (
          <span className="assistant-unread" aria-label="有新回复" />
        )}
      </button>
      <button
        className="assistant-position-toggle"
        aria-label={placement.docked ? "展开助手图标" : "将助手图标贴边收起"}
        title={placement.docked ? "展开助手图标" : "贴边收起，减少遮挡"}
        onClick={() => setPlacement((p) => ({ ...p, docked: !p.docked }))}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d={
              (placement.side === "right") === placement.docked
                ? "m15 6-6 6 6 6"
                : "m9 6 6 6-6 6"
            }
          />
        </svg>
      </button>
      <span className="assistant-position-help" id="assistant-position-help">
        按住图标或边缘标签拖动，松手吸附左右边缘。方向键调整位置，小箭头切换贴边收起。位置自动保存。
      </span>
    </div>
  );
}
