import { P2pkhSettingsPage } from "@keymaster/plugin-p2pkh/settings-page";
import { WocSettingsPage } from "@keymaster/plugin-woc/settings-page";
import { useI18n } from "@keymaster/runtime";
import { PageHeader } from "@keymaster/ui";

export function BsvChainSettingsPage() {
  const { t } = useI18n();

  return (
    <div className="bsv-chain-page">
      <PageHeader
        title={t("bsvChain.page.title", { defaultValue: "BSV Chain" })}
        description={t("bsvChain.page.description", {
          defaultValue: "Configure P2PKH network scope, fee rates, and the WOC connection."
        })}
      />
      <div className="bsv-chain-page__sections">
        <section className="bsv-chain-page__section" id="p2pkh" aria-labelledby="bsv-chain-p2pkh-title">
          <header className="bsv-chain-page__section-header">
            <h2 id="bsv-chain-p2pkh-title">{t("bsvChain.p2pkh", { defaultValue: "P2PKH" })}</h2>
          </header>
          <P2pkhSettingsPage />
        </section>
        <section className="bsv-chain-page__section" id="woc" aria-labelledby="bsv-chain-woc-title">
          <header className="bsv-chain-page__section-header">
            <h2 id="bsv-chain-woc-title">{t("bsvChain.woc", { defaultValue: "WOC" })}</h2>
          </header>
          <WocSettingsPage />
        </section>
      </div>
    </div>
  );
}
