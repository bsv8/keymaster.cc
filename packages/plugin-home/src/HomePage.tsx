// packages/plugin-home/src/HomePage.tsx
// 首页：从 home.registry 读取 widget，按 runtime 已解析的 slot 分组为 main / aside 双栏。
// 插件只声明业务 space，空间到布局的映射属于 runtime 产品规则。

import { EmptyState, PageHeader } from "@keymaster/ui";
import { countRender, useCapability, useI18n } from "@keymaster/runtime";
import type { HomeRegistry, HomeWidget } from "@keymaster/contracts";
import { BusinessHomePage } from "./BusinessHomePage.js";

/**
 * 把 widget 列表按 runtime 解析后的 slot 分组。
 * 栏目内维持输入顺序（registry.list() 已按 order 升序），不再二次排序。
 * 暴露为纯函数，便于在 node 单测中验证栏目分发行为。
 */
export function partitionHomeWidgets(widgets: readonly HomeWidget[]): {
  main: HomeWidget[];
  aside: HomeWidget[];
} {
  const main: HomeWidget[] = [];
  const aside: HomeWidget[] = [];
  for (const w of widgets) {
    if (w.slot === "main") main.push(w);
    else if (w.slot === "aside") aside.push(w);
  }
  return { main, aside };
}

export function HomePage() {
  countRender("plugin-home/HomePage");
  const registry = useCapability<HomeRegistry>("home.registry");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const widgets = registry.list();

  if (widgets.length === 0) {
    return (
      <div className="home-page">
        <PageHeader
          title={t("home.page.title", { defaultValue: "首页" })}
          description={t("home.page.description", { defaultValue: "按插件注册的资源面板。" })}
        />
        <EmptyState
          title={t("home.page.empty.title", { defaultValue: "还没有 widget" })}
          description={t("home.page.empty.description", { defaultValue: "安装业务插件后这里会显示资源面板。" })}
        />
        <BusinessHomePage />
      </div>
    );
  }

  const { main, aside } = partitionHomeWidgets(widgets);

  return (
    <div className="home-page">
      <PageHeader
        title={t("home.page.title", { defaultValue: "首页" })}
        description={t("home.page.description", { defaultValue: "按插件注册的资源面板。" })}
      />
      <div className="home-layout">
        <div className="home-layout__main">
          {main.map((w) => (
            <div key={w.id} className="home-layout__cell">
              <w.component />
            </div>
          ))}
        </div>
        <div className="home-layout__aside">
          {aside.map((w) => (
            <div key={w.id} className="home-layout__cell">
              <w.component />
            </div>
          ))}
        </div>
      </div>
      <BusinessHomePage />
    </div>
  );
}
