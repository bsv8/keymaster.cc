// packages/plugin-home/src/HomePage.tsx
// 首页：从 home.registry 读取 widget。
// 设计缘由：首页禁止直接 import 业务 widget，只能通过 registry。

import { EmptyState, PageHeader } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { HomeRegistry, HomeWidget, HomeWidgetSize } from "@keymaster/contracts";

function sizeClass(size: HomeWidgetSize): string {
  switch (size) {
    case "sm":
      return "home-grid__cell--sm";
    case "md":
      return "home-grid__cell--md";
    case "lg":
      return "home-grid__cell--lg";
  }
}

export function HomePage() {
  const registry = useCapability<HomeRegistry>("home.registry");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const widgets = registry.list();

  return (
    <div className="home-page">
      <PageHeader
        title={t("home.page.title", { defaultValue: "首页" })}
        description={t("home.page.description", { defaultValue: "按插件注册的资源面板。" })}
      />
      {widgets.length === 0 ? (
        <EmptyState
          title={t("home.page.empty.title", { defaultValue: "还没有 widget" })}
          description={t("home.page.empty.description", { defaultValue: "安装业务插件后这里会显示资源面板。" })}
        />
      ) : (
        <div className="home-grid">
          {widgets.map((w: HomeWidget) => (
            <div key={w.id} className={`home-grid__cell ${sizeClass(w.size)}`}>
              <w.component />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
