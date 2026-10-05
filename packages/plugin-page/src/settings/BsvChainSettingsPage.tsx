import { usePluginCapability } from "webloom-framework/react";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { usePageResources } from "../PageResourceContext.js";
import { PageHeader } from "@keymaster/ui";

export function BsvChainSettingsPage() {
  const { t } = usePluginI18n();
  const pages = usePluginCapability(PAGE_UI_RENDERER_CAPABILITY);
  useResourceView(usePageResources(), "page.home", []);
  return <div className="bsv-chain-page">
    <PageHeader title={t("bsvChain.page.title", { defaultValue: "BSV Chain" })}
      description={t("bsvChain.page.description", { defaultValue: "Configure P2PKH network scope, fee rates, and the WOC connection." })} />
    <div className="bsv-chain-page__sections">{pages.renderSettings("/settings/bsv-chain")}</div>
  </div>;
}
