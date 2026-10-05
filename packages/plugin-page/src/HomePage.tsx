// 首页容器由 Page 管理；业务卡片以贡献实例身份渲染。

import { PageHeader } from "@keymaster/ui";
import { usePluginCapability, countRender } from "webloom-framework/react";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { usePageResources } from "./PageResourceContext.js";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";

export function HomePage() {
  countRender("plugin-page/HomePage");
  const pages = usePluginCapability(PAGE_UI_RENDERER_CAPABILITY);
  // 通过本实例资源订阅变化，撤销期间不再调用已失效的 capability 方法。
  useResourceView(usePageResources(), "page.home", []);
  // 首页仅在 Vault 已放行的已解锁框架内呈现；业务卡片仍校验自身身份资源。
  const unlocked = true;
  const { t } = usePluginI18n();

  return (
    <div className="home-page">
      <PageHeader
        title={t("home.page.title", { defaultValue: "首页" })}
        description={t("home.page.description", { defaultValue: "常用操作" })}
      />
      <div className="home-layout">
        <div className="home-layout__main">
          {pages.renderHome("main", unlocked)}
        </div>
        <div className="home-layout__aside">
          {pages.renderHome("aside", unlocked)}
        </div>
      </div>
    </div>
  );
}
