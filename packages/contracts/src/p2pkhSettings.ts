import { defineCapability } from "webloom-framework";

/** 跨插件身份展示只需测试网开关，不获得 P2PKH 管理/转账服务。 */
export interface P2pkhSettingsReader {
  includeTestnet(): boolean;
  onChange(listener: () => void): () => void;
}
export const P2PKH_SETTINGS_READER_CAPABILITY = defineCapability<P2pkhSettingsReader>({
  kind: "local", id: "p2pkh.settings-reader", version: "1",
});
