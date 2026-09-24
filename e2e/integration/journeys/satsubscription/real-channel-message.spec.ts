import { createHash } from "node:crypto";
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bytesToHex, publicKeyFromPrivateKey } from "bitcoin-libp2p/identity";
import { readLocalCatalog } from "../../drivers/appDriver.js";
import { initializeLocalUserWithImportedHexKey } from "../../drivers/initialSetupDriver.js";
import {
  enableSatSupplierReceiveAndDefault,
  saveSatSupplierFromPage,
  waitForSatSupplierConnectionState,
} from "../../drivers/satSubscriptionDriver.js";
import { openSettingsPage } from "../../drivers/settingsDriver.js";
import {
  countChatMessageBubbles,
  expectChatMessageBubble,
  openMessages,
  openNewChat,
  sendChatMessage,
} from "../../drivers/messageDriver.js";
import { reloadAndAssertSameKey, unlockWalletInPlace } from "../../drivers/vaultDriver.js";
import {
  startSatSubscriptionLocalServer,
  type SatSubscriptionLedgerSummary,
  type SatSubscriptionLocalServer,
} from "../../resources/satsubscription/localServerResource.js";
import { attachBrowserErrors, captureBrowserErrors } from "../../support/browserEvidence.js";
import { deleteRawLocalBucketObject, readRawLocalBucketObjects, type RawBucketObjectEntry } from "../../support/localBucketFormats.js";
import { attachVisibleDiagnostic } from "../../support/diagnostics.js";
import { REAL_SATSUB_MESSAGE_SCENARIO } from "../../support/scenarioMetadata.js";
import type { BrowserErrorEvidence } from "../../support/types.js";

export const JOURNEY_ID = REAL_SATSUB_MESSAGE_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUB_MESSAGE_SCENARIO;

const PREVIEW_ORIGIN = "http://127.0.0.1:4173";
const SUPPLIER_ID = "real-satsubscription-local";
const SUPPLIER_NAME = "真实 SatSubscription 本地供应商";
const USER_A_PASSWORD = "real-sat-message-a-password";
const USER_B_PASSWORD = "real-sat-message-b-password";
const USER_C_PASSWORD = "real-sat-message-c-password";
/** 固定短期私钥；只用于本次测试的 testnet 白名单身份，不进入附件。 */
const USER_A_PRIVATE_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const USER_B_PRIVATE_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000002";
const USER_C_PRIVATE_KEY_HEX = "0000000000000000000000000000000000000000000000000000000000000003";
const MESSAGE_BODY = "real-satsubscription-message-001";

/** MasterSeed `keymaster-seed-v1`：文件内容 → seed_hash。 */
function masterSeedHashHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const digests: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 262144) {
    digests.push(createHash("sha256").update(bytes.subarray(offset, Math.min(offset + 262144, bytes.byteLength))).digest());
  }
  return createHash("sha256").update(Buffer.concat(digests)).digest("hex");
}

function messageObjects(entries: readonly RawBucketObjectEntry[], owner: string): RawBucketObjectEntry[] {
  return entries.filter((entry) => entry.path.startsWith(`${owner}/messages/`));
}

interface RealUser {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly publicKeyHex: string;
  readonly password: string;
  readonly privateKeyHex: string;
  readonly browserErrors: BrowserErrorEvidence;
}

/** 每个用户一个独立浏览器进程；P2P 测试不共享浏览器网络和运行态。 */
async function launchUser(input: {
  readonly password: string;
  readonly privateKeyHex: string;
  readonly bucketLabel: string;
  readonly keyLabel: string;
}): Promise<RealUser> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: PREVIEW_ORIGIN });
  const page = await context.newPage();
  const browserErrors = captureBrowserErrors(page, context);
  const ready = await initializeLocalUserWithImportedHexKey(page, {
    bucketLabel: input.bucketLabel,
    keyLabel: input.keyLabel,
    password: input.password,
    privateKeyHex: input.privateKeyHex,
  });
  return {
    browser,
    context,
    page,
    publicKeyHex: ready.publicKeyHex,
    password: input.password,
    privateKeyHex: input.privateKeyHex,
    browserErrors,
  };
}

/** 通过真实广播网关页保存真实供应商，并启用接收与默认发布。 */
async function configureRealSupplier(user: RealUser, server: SatSubscriptionLocalServer): Promise<void> {
  await openSettingsPage(user.page, {
    label: /^Broadcast gateway$|^广播网关$/u,
    path: /\/settings\/system-status$/u,
    heading: /^Broadcast gateway$|^广播网关$/u,
  });
  await saveSatSupplierFromPage(user.page, {
    supplierId: SUPPLIER_ID,
    name: SUPPLIER_NAME,
    supplierPublicKeyHex: server.supplierPublicKeyHex,
    multiaddrs: [server.multiaddr],
    enabled: true,
  });
  await waitForSatSupplierConnectionState(user.page, SUPPLIER_ID, "online");
  await enableSatSupplierReceiveAndDefault(user.page, SUPPLIER_ID);
}

function findOperation(ledger: SatSubscriptionLedgerSummary, operationType: string) {
  return ledger.operations.find((entry) => entry.operationType === operationType);
}

async function attachUserEvidence(testInfo: Parameters<typeof attachBrowserErrors>[0], user: RealUser): Promise<void> {
  await attachBrowserErrors(testInfo, user.browserErrors, [user.password, user.privateKeyHex]);
  await attachVisibleDiagnostic(user.page, testInfo);
}

/**
 * 业务目标：两个不同身份的本地用户，通过仓库外 SatSubscription 的正式服务
 * 互发一条 Channel 私密消息；服务端账本证明真实订阅和免费白名单 0 扣费。
 *
 * 开始状态：Node 侧从 SATS_SUBSCRIPTION_DIR 构建 `cmd/satsubscription`，启动
 * 一次性 PostgreSQL 和 testnet 供应商；三个用户各自一个独立浏览器进程，
 * 使用确定性 Hex Key，并在服务端永久免费白名单内。
 *
 * 成功标准：
 * - 三个浏览器都通过真实页面完成供应商身份 pin 和 online 连接；
 * - 服务端 relations 出现 B/C 的 `bsv8.inbox.<pub>` 订阅；
 * - A 发送后 B 的会话页出现消息，A 保留自己的已发送记录；
 * - 真实账本出现 ssp-publish/ssp-subscribe 操作且 charged_subunits 全为 0；
 * - B 刷新并重新解锁后历史仍在本地；
 * - 独立浏览器 C 看不到这条消息。
 *
 * 业务风险：把页面点击、供应商连接或本地记录任一项当成远端已收到都会误导
 * 用户；本场景同时要求页面可见结果和真实账本证据。
 *
 * 外部资源与收尾：只使用一次性 PostgreSQL、随机服务身份和回环地址；
 * 结束时关闭浏览器、服务进程和临时目录，不产生真实资金流动。
 *
 * 覆盖需求：KM-MESSAGE-001、KM-SATSUB-001。
 */
test(JOURNEY_ID + "：真实 SatSubscription 供应商的 Channel 私信", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const whitelistPublicKeys = [USER_A_PRIVATE_KEY_HEX, USER_B_PRIVATE_KEY_HEX, USER_C_PRIVATE_KEY_HEX].map((privateKeyHex) =>
    bytesToHex(publicKeyFromPrivateKey(Uint8Array.from(Buffer.from(privateKeyHex, "hex")))),
  );
  const server = await startSatSubscriptionLocalServer({ whitelistPublicKeys });
  const users: RealUser[] = [];

  try {
    await test.step("三个用户使用独立浏览器进程建立可恢复身份", async () => {
      const [userA, userB, userC] = await Promise.all([
        launchUser({ password: USER_A_PASSWORD, privateKeyHex: USER_A_PRIVATE_KEY_HEX, bucketLabel: "真实 Sat 消息 A", keyLabel: "真实 Sat 消息 A Key" }),
        launchUser({ password: USER_B_PASSWORD, privateKeyHex: USER_B_PRIVATE_KEY_HEX, bucketLabel: "真实 Sat 消息 B", keyLabel: "真实 Sat 消息 B Key" }),
        launchUser({ password: USER_C_PASSWORD, privateKeyHex: USER_C_PRIVATE_KEY_HEX, bucketLabel: "真实 Sat 消息 C", keyLabel: "真实 Sat 消息 C Key" }),
      ]);
      users.push(userA, userB, userC);
      expect(new Set(users.map((user) => user.publicKeyHex)).size).toBe(3);
      expect(users.map((user) => user.publicKeyHex).sort()).toEqual([...whitelistPublicKeys].sort());
    });

    await test.step("三个用户连接真实供应商并启用接收与默认发布", async () => {
      for (const user of users) await configureRealSupplier(user, server);
    });

    await test.step("真实账本登记了三个 owner inbox 订阅", async () => {
      const inboxA = `bsv8.inbox.${users[0]!.publicKeyHex}`;
      const inboxB = `bsv8.inbox.${users[1]!.publicKeyHex}`;
      const inboxC = `bsv8.inbox.${users[2]!.publicKeyHex}`;
      await expect.poll(async () => (await server.ledgerSummary()).subscriptionChannels, {
        timeout: 60_000,
        message: "真实账本未登记全部 owner inbox 订阅",
      }).toEqual(expect.arrayContaining([inboxA, inboxB, inboxC]));
    });

    await test.step("A 通过消息页向 B 的公钥发送私信", async () => {
      const [userA, userB] = users;
      await openMessages(userA!.page);
      await openNewChat(userA!.page, userB!.publicKeyHex);
      await sendChatMessage(userA!.page, MESSAGE_BODY);
      await expectChatMessageBubble(userA!.page, MESSAGE_BODY, "me");
    });

    await test.step("B 的会话页收到来自 A 的消息", async () => {
      const [userA, userB] = users;
      await openMessages(userB!.page);
      await openNewChat(userB!.page, userA!.publicKeyHex);
      await expectChatMessageBubble(userB!.page, MESSAGE_BODY, "peer");
    });

    await test.step("本地桶按 formats 保存 raw 证据与时间索引", async () => {
      const [userA, userB] = users;
      const aObjects = messageObjects(await readRawLocalBucketObjects(userA!.page), userA!.publicKeyHex);
      const bObjects = messageObjects(await readRawLocalBucketObjects(userB!.page), userB!.publicKeyHex);

      // 出站：签名明文 raw + kind=sent 的时间索引。
      const sentPath = `${userA!.publicKeyHex}/messages/${userB!.publicKeyHex}/sent/`;
      const sentRaw = aObjects.find((entry) => entry.path.startsWith(sentPath));
      expect(sentRaw, "A 桶缺少 sent raw").toBeTruthy();
      const sentHash = sentRaw!.path.slice(sentPath.length).replace(/\.json$/u, "");
      expect(sentHash).toBe(masterSeedHashHex(sentRaw!.text));
      const sentPlaintext = JSON.parse(sentRaw!.text) as Record<string, unknown>;
      expect(sentPlaintext.protocol).toBe("bsv8.message.v1");
      expect(typeof sentPlaintext.message_id).toBe("string");
      const sentIndex = aObjects.find((entry) => entry.path.startsWith(`${userA!.publicKeyHex}/messages/${userB!.publicKeyHex}/timeindex/`));
      expect(sentIndex, "A 桶缺少 sent 时间索引").toBeTruthy();
      expect(JSON.parse(sentIndex!.text)).toMatchObject({ format: "keymaster.message-index", version: 1, kind: "sent", rawHash: sentHash, messageId: sentPlaintext.message_id });

      // 入站：加密信封 raw + kind=received 的时间索引。
      const receivedPath = `${userB!.publicKeyHex}/messages/${userA!.publicKeyHex}/received/`;
      const receivedRaw = bObjects.find((entry) => entry.path.startsWith(receivedPath));
      expect(receivedRaw, "B 桶缺少 received raw").toBeTruthy();
      const receivedHash = receivedRaw!.path.slice(receivedPath.length).replace(/\.json$/u, "");
      expect(receivedHash).toBe(masterSeedHashHex(receivedRaw!.text));
      const envelope = JSON.parse(receivedRaw!.text) as Record<string, unknown>;
      expect(envelope.envelope_version).toBe(1);
      expect(envelope.from_public_key).toBe(userA!.publicKeyHex);
      expect(typeof envelope.ciphertext).toBe("string");
      expect("protocol" in envelope).toBe(false);
      const receivedIndex = bObjects.find((entry) => entry.path.startsWith(`${userB!.publicKeyHex}/messages/${userA!.publicKeyHex}/timeindex/`));
      expect(receivedIndex, "B 桶缺少 received 时间索引").toBeTruthy();
      expect(JSON.parse(receivedIndex!.text)).toMatchObject({ kind: "received", rawHash: receivedHash, messageId: sentPlaintext.message_id });

      // 第三方 C 的桶里不应出现任何 messages 证据目录。
      const cObjects = messageObjects(await readRawLocalBucketObjects(users[2]!.page), users[2]!.publicKeyHex);
      expect(cObjects).toHaveLength(0);
    });

    await test.step("真实账本的 Publish/Subscribe 计费为 0", async () => {
      const ledger = await server.ledgerSummary();
      const publish = findOperation(ledger, "operation:ssp-publish");
      const subscribe = findOperation(ledger, "operation:ssp-subscribe");
      expect(publish?.count ?? 0).toBeGreaterThanOrEqual(1);
      expect(subscribe?.count ?? 0).toBeGreaterThanOrEqual(1);
      expect(publish?.chargedSubunits).toBe("0");
      expect(subscribe?.chargedSubunits).toBe("0");
      expect(ledger.operations.every((entry) => entry.chargedSubunits === "0")).toBe(true);
    });

    await test.step("B 刷新并重新解锁后本地历史仍然存在", async () => {
      const userB = users[1]!;
      await reloadAndAssertSameKey(userB.page, "");
      await unlockWalletInPlace(userB.page, userB.password);
      await expect(userB.page.locator('[data-message-detail="ok"]')).toBeVisible({ timeout: 30_000 });
      await expectChatMessageBubble(userB.page, MESSAGE_BODY, "peer");
    });

    await test.step("raw 缺失时索引保留并显示缺失", async () => {
      const userA = users[0]!;
      const userB = users[1]!;
      const catalog = await readLocalCatalog(userB.page);
      const bucketId = catalog?.selectedBucketId;
      if (!bucketId) throw new Error("B 缺少选中桶 ID");
      const objects = messageObjects(await readRawLocalBucketObjects(userB.page), userB.publicKeyHex);
      const receivedRaw = objects.find((entry) => entry.path.startsWith(`${userB.publicKeyHex}/messages/${userA.publicKeyHex}/received/`));
      expect(receivedRaw, "B 桶缺少 received raw").toBeTruthy();
      await deleteRawLocalBucketObject(userB.page, bucketId, receivedRaw!.path);
      await reloadAndAssertSameKey(userB.page, "");
      await unlockWalletInPlace(userB.page, userB.password);
      await expect(userB.page.locator('[data-message-detail="ok"]')).toBeVisible({ timeout: 30_000 });
      await expect(userB.page.getByText(/原始消息数据缺失|Original message data is missing/iu)).toBeVisible({ timeout: 30_000 });
    });

    await test.step("独立浏览器 C 打开与 A 的会话看不到这条消息", async () => {
      const userA = users[0]!;
      const userC = users[2]!;
      await openMessages(userC.page);
      await openNewChat(userC.page, userA.publicKeyHex);
      await expect(userC.page.getByText(/当前会话暂无消息|No messages in this conversation/iu)).toBeVisible();
      expect(await countChatMessageBubbles(userC.page, MESSAGE_BODY)).toBe(0);
    });
  } finally {
    for (const user of users) await attachUserEvidence(testInfo, user);
    await Promise.all(users.map((user) => user.context.close().catch(() => undefined)));
    await Promise.all(users.map((user) => user.browser.close().catch(() => undefined)));
    await server.stop();
  }
});
