import { expect, test } from "@playwright/test";
import { initializeNewLocalUser } from "../../flows/initializeLocalUser.js";
import {
  readSatSupplierRow,
  saveSatSupplierFromPage,
  waitForSatSupplierConnectionFailure,
  waitForSatSupplierConnectionState,
  type SatSupplierFormInput,
} from "../../drivers/satSubscriptionDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import { loadE2ESatSubscriptionConfig } from "../../resources/config/loader.js";
import type { LoadedE2ESatSubscriptionConfig } from "../../resources/config/types.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { REAL_SATSUBSCRIPTION_PAGE_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = REAL_SATSUBSCRIPTION_PAGE_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUBSCRIPTION_PAGE_SCENARIO;

const LOCAL_PASSWORD = "real-sat-page-password-123";
const SUPPLIER_ID = "real-sat-supplier";
const SUPPLIER_NAME = "真实 Sat 测试供应商";

/** 仅切换压缩公钥前缀，构造与真实供应商不同但格式仍合法的错误 pin。 */
function wrongSupplierPublicKeyHex(publicKeyHex: string): string {
  return publicKeyHex.startsWith("02") ? `03${publicKeyHex.slice(2)}` : `02${publicKeyHex.slice(2)}`;
}

/**
 * 业务目标：用户在真实 /settings/system 页面配置 SatSubscription 供应商，
 * 先看到故意错误身份的失败，再用 satsubscription.json 中的正确身份看到在线。
 *
 * 开始状态：全新 Chromium context；用户先通过真实 Local 页面建立 active Key。
 * Node 只读取仓库外 satsubscription.json，不读取应用内部 service、SharedWorker
 * API 或 Sat 网络；websocket/webrtc-direct 字段原样作为页面 multiaddrs 输入。
 *
 * 成功标准：保存提示、供应商身份和连接状态全部来自页面可见文本；错误 pin
 * 显示 disconnected/degraded，正确 pin 显示 online。故意错误用例只是同一
 * 页面 Journey 的比较步骤，不能替代正确参数的在线验证。
 *
 * 外部资源与收尾：页面只建立真实供应商连接；关闭 BrowserContext 后本地状态
 * 丢弃，连接由页面/Coordinator 生命周期收尾，不调用 Node 侧 WebSocket 清理。
 *
 * 覆盖需求：KM-SATSUB-001。
 */
test(JOURNEY_ID + "：真实页面保存 Sat 供应商并比较错误身份", async ({ page, context }, testInfo) => {
  test.setTimeout(150_000);
  const browserErrors = captureBrowserErrors(page, context);
  let config: LoadedE2ESatSubscriptionConfig | undefined;

  try {
    config = await test.step("Node 读取仓库外 Sat 配置并映射页面字段", async () => {
      return loadE2ESatSubscriptionConfig();
    });

    const multiaddrs = [config.satsubscription.websocket, config.satsubscription.webrtcDirect];
    const correct: SatSupplierFormInput = {
      supplierId: SUPPLIER_ID,
      name: SUPPLIER_NAME,
      supplierPublicKeyHex: config.satsubscription.supplierPublicKeyHex,
      multiaddrs,
      enabled: true,
    };
    const wrong: SatSupplierFormInput = {
      ...correct,
      supplierPublicKeyHex: wrongSupplierPublicKeyHex(correct.supplierPublicKeyHex),
    };

    await test.step("用户通过真实 Local 页面建立 active Key", async () => {
      await initializeNewLocalUser(
        { page },
        { bucketLabel: "真实 Sat 页面测试桶", keyLabel: "真实 Sat 页面测试 Key", password: LOCAL_PASSWORD },
      );
    });

    await test.step("用户从正式菜单打开系统设置", async () => {
      await openSettingsPage(page, {
        label: /^System$|^系统$/u,
        path: /\/settings\/system$/u,
        heading: /^System$|^系统$/u,
      });
    });

    await test.step("用户先保存故意错误的供应商公钥并看到页面失败", async () => {
      await saveSatSupplierFromPage(page, wrong);
      await waitForSatSupplierConnectionFailure(page, SUPPLIER_ID);
      const row = await readSatSupplierRow(page, SUPPLIER_ID);
      expect(row).toContain(wrong.supplierPublicKeyHex);
      expect(row).toMatch(/(?:连接(?:状态)?|Connection(?: state)?)\s*[:：]\s*(?:disconnected|degraded)\b/iu);
    });

    await test.step("用户改回配置文件中的正确公钥并看到页面在线", async () => {
      await saveSatSupplierFromPage(page, correct);
      await waitForSatSupplierConnectionState(page, SUPPLIER_ID, "online");
      const row = await readSatSupplierRow(page, SUPPLIER_ID);
      expect(row).toContain(correct.supplierPublicKeyHex);
      expect(row).toMatch(/(?:连接(?:状态)?|Connection(?: state)?)\s*[:：]\s*online\b/iu);
    });
  } finally {
    await attachBrowserErrors(testInfo, browserErrors, [LOCAL_PASSWORD]);
    await attachVisibleDiagnostic(page, testInfo);
  }
});
