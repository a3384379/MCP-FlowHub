import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./shared";

export function DiscoveryDrawer({
  label,
  close,
  children,
  footer,
}: {
  label: string;
  close: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null,
      previousOverflow = document.body.style.overflow;
    const siblings = [...document.body.children].filter(
      (e) => e !== root.current,
    ) as HTMLElement[];
    const prior = siblings.map((e) => e.inert);
    siblings.forEach((e) => (e.inert = true));
    document.body.style.overflow = "hidden";
    root.current?.querySelector<HTMLButtonElement>(".d-close")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key !== "Tab") return;
      const nodes = [
        ...root.current!.querySelectorAll<HTMLElement>(
          "button:not(:disabled),a[href],input,select,textarea,summary,[tabindex='0']",
        ),
      ].filter((n) => n.getClientRects().length);
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      siblings.forEach((e, i) => (e.inert = prior[i]!));
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return createPortal(
    <div
      className="d-overlay"
      ref={root}
      onClick={(e) => {
        if (e.target === root.current) close();
      }}
    >
      <section
        className="d-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="d-drawer-title"
      >
        <header>
          <span>{label}</span>
          <button className="d-close" onClick={close} aria-label="关闭详情">
            <Icon name="close" />
          </button>
        </header>
        <div className="d-drawer-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>,
    document.body,
  );
}
