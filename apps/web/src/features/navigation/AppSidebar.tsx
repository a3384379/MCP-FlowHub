import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  navigationForPage,
  navigationGroups,
  navigationLabel,
  navigationMedia,
  type NavigationKey,
} from "./navigation";
import "./navigation.css";
import { useVisualViewport } from "../../shared/viewport";

export function NavigationIcon({
  name,
}: {
  name: NavigationKey | "menu" | "close" | "logout";
}) {
  const paths = {
    workflows: (
      <>
        <rect x="3" y="3" width="6" height="6" rx="1.5" />
        <rect x="15" y="15" width="6" height="6" rx="1.5" />
        <path d="M6 9v6a3 3 0 0 0 3 3h6M15 6h6M18 3v6" />
      </>
    ),
    runs: (
      <>
        <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" />
      </>
    ),
    discovery: (
      <>
        <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3M17 17l4 4" />
        <circle cx="11" cy="11" r="5" />
      </>
    ),
    connections: (
      <>
        <path d="M8 3v5M16 3v5M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4" />
      </>
    ),
    bindings: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    models: (
      <>
        <path d="M12 4v16M8 4a3 3 0 0 0-4 3 4 4 0 0 0-1 7 4 4 0 0 0 5 6h4M16 4a3 3 0 0 1 4 3 4 4 0 0 1 1 7 4 4 0 0 1-5 6h-4M4 10h4l2 3M20 10h-4l-2 3" />
      </>
    ),
    settings: (
      <>
        <path d="M3 6h5M12 6h9M3 18h9M16 18h5" />
        <circle cx="10" cy="6" r="2" />
        <circle cx="14" cy="18" r="2" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    logout: (
      <>
        <path d="M9 4H4v16h5M9 12h12M16 7l5 5-5 5" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

type Props = {
  page: string;
  open: boolean;
  close: () => void;
  navigate: (path: string) => boolean;
  logout: () => void;
  busy: boolean;
};

function SidebarContent({
  page,
  close,
  navigate,
  logout,
  busy,
  mobile = false,
}: Props & { mobile?: boolean }) {
  const active = navigationForPage(page)?.key;
  return (
    <aside className="sidebar app-sidebar" aria-label="主导航">
      <div className="app-brand-row">
        <div className="app-brand">
          <span className="app-brand-mark">F</span>
          <span className="app-brand-name">FlowHub</span>
        </div>
        {mobile && (
          <button
            className="navigation-close"
            onClick={close}
            aria-label="关闭导航"
          >
            <NavigationIcon name="close" />
          </button>
        )}
      </div>
      <p className="app-workspace">本机工作空间 · 单用户</p>
      <nav aria-label="主菜单">
        {navigationGroups.map((group) => (
          <section
            className="app-nav-group"
            aria-labelledby={"app-nav-" + group.id}
            key={group.id}
          >
            <h2 id={"app-nav-" + group.id}>{group.label}</h2>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.key}
                className="app-nav-item"
                aria-current={active === item.key ? "page" : undefined}
                onClick={() => {
                  if (navigate("/" + item.key)) close();
                }}
              >
                <NavigationIcon name={item.key} />
                <span>{item.label}</span>
              </button>
            ))}
          </section>
        ))}
      </nav>
      <div className="app-sidebar-account">
        <span className="app-avatar" aria-hidden="true">
          AD
        </span>
        <div>
          <strong>本机管理员</strong>
          <small>本地运行模式</small>
        </div>
        <button aria-label="退出登录" disabled={busy} onClick={logout}>
          <NavigationIcon name="logout" />
          <span className="navigation-logout-label">退出登录</span>
        </button>
      </div>
    </aside>
  );
}

function MobileNavigation(props: Props) {
  const viewport = useVisualViewport();
  const root = useRef<HTMLDivElement>(null),
    close = useRef(props.close);
  close.current = props.close;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const siblings = [...document.body.children].filter(
      (element) => element !== root.current,
    ) as HTMLElement[];
    const previousInert = siblings.map((element) => element.inert),
      previousOverflow = document.body.style.overflow;
    siblings.forEach((element) => {
      element.inert = true;
    });
    document.body.style.overflow = "hidden";
    const focusable = () =>
      [
        ...root.current!.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ),
      ].filter((element) => element.getClientRects().length > 0);
    root.current
      ?.querySelector<HTMLButtonElement>(".navigation-close")
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = focusable(),
        first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      siblings.forEach((element, index) => {
        element.inert = previousInert[index]!;
      });
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected && opener.getClientRects().length)
        opener.focus({ preventScroll: true });
      else
        document
          .querySelector<HTMLButtonElement>(
            ".app-sidebar [aria-current='page']",
          )
          ?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <div
      className="navigation-overlay"
      data-compact={viewport.width < 220 ? "true" : undefined}
      style={{
        left: viewport.left,
        top: viewport.top,
        width: viewport.width,
        height: viewport.height,
        right: "auto",
        bottom: "auto",
      }}
      ref={root}
      onPointerDown={(event) => {
        if (event.target === root.current) props.close();
      }}
    >
      <div
        id="mobile-navigation"
        className="navigation-drawer"
        style={{
          width: Math.min(
            272,
            viewport.width < 320 ? viewport.width : viewport.width - 40,
          ),
        }}
        role="dialog"
        aria-modal="true"
        aria-label="主导航"
      >
        <SidebarContent {...props} mobile />
      </div>
    </div>,
    document.body,
  );
}

export function AppSidebar(props: Props) {
  const [mobile, setMobile] = useState(
    () => window.matchMedia(navigationMedia).matches,
  );
  const close = useRef(props.close);
  close.current = props.close;
  useEffect(() => {
    const media = window.matchMedia(navigationMedia);
    const change = () => {
      setMobile(media.matches);
      if (!media.matches) close.current();
    };
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    document.title = navigationLabel(props.page) + " · FlowHub";
  }, [props.page]);
  return mobile ? (
    props.open ? (
      <MobileNavigation {...props} />
    ) : null
  ) : (
    <SidebarContent {...props} />
  );
}
