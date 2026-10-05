import type { OwnedResourceReader } from "@keymaster/contracts";
import { usePluginI18n, useResourceView } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import type { HoldingRowsResult } from "./holdingsFlow.js";

export function AssetsHomeWidget({ reader }: { reader: OwnedResourceReader }) {
  const { t } = usePluginI18n();
  const data = useResourceView<HoldingRowsResult>(reader, "assets.holdings", []).data;
  return <section className="asset-overview-home">
    <strong>{t("assets.home.overview")}</strong>
    <div className="asset-overview-home__count">{(data?.assets.length ?? 0) + (data?.tokens.length ?? 0)}</div>
    <Button onClick={() => reader.invalidate("assets.holdings", [])}>{t("assets.page.refresh")}</Button>
  </section>;
}
