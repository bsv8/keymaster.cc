import { useState } from "react";
import { usePageRenderer, PageHeaderOutlet } from "./PageOutlet.js";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { SiteFooter } from "./SiteFooter.js";
import { Topbar } from "./Topbar.js";
import { NoticeRail } from "./NoticeRail.js";
export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const page = usePageRenderer();
  return <div className={`app-shell ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
    <PageHeaderOutlet slot="above-header" />
    <Topbar mobileOpen={mobileOpen} onToggleMobileNav={() => setMobileOpen(v => !v)} />
    <div className="app-shell__body">
      <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      {mobileOpen ? <button type="button" className="app-shell__backdrop" aria-label="关闭菜单" onClick={() => setMobileOpen(false)} /> : null}
      <main className="app-shell__main"><NoticeRail />
        <div className="app-shell__paged">{page?.renderFrame("wallet-guard", <><Breadcrumbs /><RouteRenderer /></>)}</div>
      </main>
    </div><SiteFooter variant="app" />
    {page?.renderFrame("uri-action")}
  </div>;
}
