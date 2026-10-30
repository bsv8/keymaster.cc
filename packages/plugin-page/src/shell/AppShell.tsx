import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Menu, X, Home, MessageSquare, PanelLeftClose, PanelLeftOpen, ArrowUpToLine, ArrowDownToLine, LayoutGrid } from "lucide-react";
import * as Icons from "lucide-react";
import type { BusinessDomain } from "@keymaster/contracts";
import { useCurrentPath, usePluginI18n, useResourceViewSelector } from "@keymaster/runtime";
import { usePageResources } from "../PageResourceContext.js";
import { usePageRenderer, PageHeaderOutlet } from "./PageOutlet.js";
import { RouteRenderer, router } from "./RouteRenderer.js";
import { BusinessNavigation, isBusinessFeatureActive } from "./BusinessNavigation.js";
import { NoticeRail } from "./NoticeRail.js";
import { ThemeToggle } from "../theme/ThemeToggle.js";
import { LanguageSwitch } from "../i18n/LanguageSwitch.js";
import "./workspace.css";

export function AppShell() {
  const page = usePageRenderer()!;
  const resources = usePageResources();
  const { text, t } = usePluginI18n();
  const path = useCurrentPath();
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width:640px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<"sessions" | "menu">("sessions");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileSessions, setMobileSessions] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(480);
  const [listHeight, setListHeight] = useState(200);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useSyncExternalStore(page.subscribe, page.revision, page.revision);
  const domains = useResourceViewSelector<BusinessDomain[], BusinessDomain[]>(resources, "page.navigation", [], state => state.data ?? []);
  const feature = domains.flatMap(domain => domain.features).find(item => isBusinessFeatureActive(item, path));
  const title = feature ? text(feature.label) : path === "/" ? t("home.page.title", { defaultValue: "首页" }) : path.split("/").filter(Boolean).at(-1) ?? "";
  const MenuIcon = (feature?.icon ? (Icons as unknown as Record<string, typeof Home>)[feature.icon] : undefined) ?? Home;
  const views = page.applicationViews();
  const activeApp = page.activeApplication();
  const resultViews = page.resultViews();
  const activeResult = page.activeResult();
  const attachOutlet = useCallback((element: HTMLDivElement | null) => page.attachApplicationOutlet(element), [page]);
  useEffect(() => {
    const media = window.matchMedia("(max-width:640px)");
    const update = () => { setMobile(media.matches); setMobileMenuOpen(false); };
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { page.selectApplication(null); setMobileSessions(false); setMobileMenuOpen(false); }, [path, page]);
  useEffect(() => { if (activeApp) { setMobileSessions(false); setMobileMenuOpen(false); } }, [activeApp]);
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setMobileMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); setMobileMenuOpen(false); menuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [mobileMenuOpen]);
  useEffect(() => () => dragCleanup.current?.(), [mobile, sidebarOpen, sidebarTab, maximized]);
  /** 捕获拖动指针，隔离 iframe；从实际尺寸起拖，避免动画和 CSS 限宽造成跳动。 */
  function beginResize(axis: "width" | "height", event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); dragCleanup.current?.();
    const handle = event.currentTarget;
    const shell = handle.closest<HTMLElement>(".workspace-shell")!;
    const bounds = handle.previousElementSibling!.getBoundingClientRect();
    const pointerId = event.pointerId;
    const start = axis === "width" ? event.clientX : event.clientY;
    const size = axis === "width" ? bounds.width : bounds.height;
    const cursor = document.body.style.cursor, selection = document.body.style.userSelect;
    handle.setPointerCapture(pointerId);
    shell.dataset.resizing = axis;
    if (axis === "width") setSidebarWidth(size);
    else setListHeight(size);
    document.body.style.cursor = axis === "width" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    let ended = false;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      // 在浏览器外松手后返回时也必须结束，不能继续黏着鼠标。
      if (!(next.buttons & 1)) { end(); return; }
      next.preventDefault();
      const delta = (axis === "width" ? next.clientX : next.clientY) - start;
      if (axis === "width") setSidebarWidth(Math.max(320, Math.min(800, window.innerWidth - 320, size + delta)));
      else setListHeight(Math.max(100, Math.min(window.innerHeight * .5, size + delta)));
    };
    const finishPointer = (next: PointerEvent) => { if (next.pointerId === pointerId) end(); };
    const end = () => {
      if (ended) return;
      ended = true;
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", finishPointer, true);
      document.removeEventListener("pointercancel", finishPointer, true);
      document.removeEventListener("lostpointercapture", finishPointer, true);
      window.removeEventListener("blur", end);
      window.removeEventListener("resize", end);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      delete shell.dataset.resizing;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = selection;
      dragCleanup.current = null;
    };
    dragCleanup.current = end;
    document.addEventListener("pointermove", move, { capture: true, passive: false });
    document.addEventListener("pointerup", finishPointer, true);
    document.addEventListener("pointercancel", finishPointer, true);
    document.addEventListener("lostpointercapture", finishPointer, true);
    window.addEventListener("blur", end);
    window.addEventListener("resize", end);
  }
  function navigate() { page.selectApplication(null); setMobileSessions(false); setMobileMenuOpen(false); }
  const applicationMenu = views.length ? <><div className="workspace-menu-caption">{t("apps.widget.title", { defaultValue: "应用" })}</div>{views.map(view => <div className={`workspace-app-menu-row${view.id === activeApp ? " is-active" : ""}`} key={view.id}><button onClick={() => { page.selectApplication(view.id); setMobileMenuOpen(false); }}><LayoutGrid size={14}/><span>{view.title}</span></button><button className="workspace-app-close" aria-label={`关闭 ${view.title}`} title={`关闭 ${view.title}`} onClick={() => view.close()}><X size={12}/></button></div>)}</> : null;
  const menu = <>{applicationMenu}<BusinessNavigation onClose={navigate}/></>;
  const conversations = <section className="workspace-conversations" aria-label="会话">
    <div className="workspace-session-list" hidden={maximized} style={{ height: listHeight }}>{page.renderFrame("ai-session-list")}</div>
    {!maximized && <div role="separator" tabIndex={0} aria-label="调整会话列表高度" aria-orientation="horizontal" className="workspace-list-resize" onPointerDown={event => beginResize("height", event)} onKeyDown={event => { if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setListHeight(value => Math.max(100, Math.min(window.innerHeight * .5, value + (event.key === "ArrowUp" ? -20 : 20)))); } }} />}
    <div className="workspace-chat"><div className="workspace-chat-header"><button className={maximized ? "is-active" : ""} title={maximized ? "恢复上下布局" : "向上最大化会话"} aria-label={maximized ? "恢复上下布局" : "向上最大化会话"} aria-pressed={maximized} onClick={() => setMaximized(value => !value)}>{maximized ? <ArrowDownToLine size={16}/> : <ArrowUpToLine size={16}/>}</button></div><div className="workspace-chat-content">{page.renderFrame("ai-conversations")}</div></div>
  </section>;
  return <div className="workspace-shell" style={{ "--workspace-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
    <PageHeaderOutlet slot="above-header" />
    <header className="workspace-header">
      {mobile && <button ref={menuButtonRef} className="workspace-icon-button" aria-label="钱包菜单" aria-expanded={mobileMenuOpen} aria-controls="workspace-mobile-menu" onClick={() => setMobileMenuOpen(value => !value)}>{mobileMenuOpen ? <X size={17}/> : <Menu size={17}/>}</button>}
      <button className="workspace-brand" aria-label="Keymaster 首页" onClick={() => { router.push("/"); navigate(); }}><span>K</span><strong>Keymaster</strong></button>
      <div className="workspace-header-spacer" />
      <div className="workspace-header-contributions"><PageHeaderOutlet slot="topbar" /></div>
      <ThemeToggle/><LanguageSwitch/>
      {mobile && mobileMenuOpen && <div ref={menuRef} id="workspace-mobile-menu" className="workspace-mobile-menu" role="dialog" aria-label="钱包菜单">{menu}</div>}
    </header>
    <div className={`workspace-body${mobileSessions ? " is-mobile-sessions" : ""}`}>
      <aside id="workspace-sidebar" className={`workspace-sidebar${sidebarOpen ? " is-open" : ""}`}>
        <div className="workspace-sidebar-header" role="tablist" aria-label="侧栏"><button role="tab" aria-selected={sidebarTab === "sessions"} className={sidebarTab === "sessions" ? "is-active" : ""} onClick={() => setSidebarTab("sessions")}><MessageSquare size={13}/>会话</button><button role="tab" aria-selected={sidebarTab === "menu"} className={sidebarTab === "menu" ? "is-active" : ""} onClick={() => setSidebarTab("menu")}><LayoutGrid size={13}/>菜单</button><span/>{sidebarTab === "sessions" && page.renderFrame("ai-session-actions")}</div>
        <div className="workspace-desktop-conversations" hidden={sidebarTab !== "sessions" || mobile}>{!mobile && conversations}</div>
        <div className="workspace-menu" hidden={sidebarTab !== "menu"}>{menu}</div>
      </aside>
      {!mobile && sidebarOpen && <div className="workspace-sidebar-resize" role="separator" tabIndex={0} aria-label="调整侧栏宽度" aria-orientation="vertical" onPointerDown={event => beginResize("width", event)} onKeyDown={event => { if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); setSidebarWidth(value => Math.max(320, Math.min(800, window.innerWidth - 320, value + (event.key === "ArrowLeft" ? -20 : 20)))); } }} />}
      <main className="workspace-main">
        <div className="workspace-tabs-row">
          {!mobile && <button className="workspace-sidebar-toggle" aria-controls="workspace-sidebar" aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"} title={sidebarOpen ? "收起侧栏" : "展开侧栏"} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? <PanelLeftClose size={16}/> : <PanelLeftOpen size={16}/>}</button>}
          <div className="workspace-tabs" role="tablist" aria-label="工作区标签">
            {resultViews.map(view => <div className={`workspace-tab-app${view.id === activeResult ? " is-active" : ""}`} key={view.id}><button role="tab" aria-selected={view.id === activeResult} onClick={() => { setMobileSessions(false); page.selectResult(view.id); }}><span>AI · {view.title}</span></button><button className="workspace-tab-close" aria-label={`关闭 ${view.title}`} onClick={() => view.close()}><X size={12}/></button></div>)}
            {mobile && <button role="tab" aria-selected={mobileSessions} className={mobileSessions ? "is-active" : ""} onClick={() => { setMobileSessions(true); page.selectApplication(null); }}><MessageSquare size={13}/>会话</button>}
            <button role="tab" aria-selected={!mobileSessions && !activeApp && !activeResult} className={!mobileSessions && !activeApp && !activeResult ? "is-active" : ""} onClick={navigate}><MenuIcon size={13}/><span>{title}</span></button>
            {views.filter(view => view.mode === "iframe").map(view => <div className={`workspace-tab-app${view.id === activeApp ? " is-active" : ""}`} key={view.id}><button role="tab" aria-selected={view.id === activeApp} onClick={() => page.selectApplication(view.id)}><LayoutGrid size={13}/><span>{view.title}</span></button><button className="workspace-tab-close" aria-label={`关闭 ${view.title}`} onClick={() => view.close()}><X size={12}/></button></div>)}
          </div>
        </div>
        {mobile && <div className="workspace-mobile-conversations" hidden={!mobileSessions}><div className="workspace-session-actions"><span>会话列表</span>{page.renderFrame("ai-session-actions")}</div>{conversations}</div>}
        <div className="workspace-route" hidden={mobileSessions || !!activeApp || !!activeResult}><NoticeRail/>{page.renderFrame("wallet-guard", <RouteRenderer/>)}</div>
        {resultViews.map(view => <div className="workspace-app-outlet" hidden={mobileSessions || activeResult !== view.id} key={view.id}>{view.render()}</div>)}
        <div ref={attachOutlet} className="workspace-app-outlet" hidden={mobileSessions || !activeApp}/>
      </main>
    </div>
    {page.renderFrame("uri-action")}
  </div>;
}
