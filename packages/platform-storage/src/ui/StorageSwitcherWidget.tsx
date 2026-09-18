// packages/platform-storage/src/ui/StorageSwitcherWidget.tsx
// 顶栏「桶 → Keys」快捷切换入口（桶切换 + Key 切换）。
//
// 交互约定：
//   - 面板列出本机设备目录中的全部桶。
//   - local 桶没有桶密码：Keys 直接读取并展示；点击 Key 后输入该 Key
//     自己的密码即可切换。
//   - s3 桶有桶密码（启动密码）：未验证前只显示桶本身；点击桶并输入
//     桶密码后才读取并展示该桶的 Keys；点击 Key 再输入 Key 密码。
//   - Key 密码验证失败或用户取消时，当前桶/当前 Key 环境保持不变。
//   - 切换成功后进入新 Key 的 home，并立即清除内存中暂存的桶密码与
//     Key 密码；取消、关闭面板时同样清除，避免密码在页面内存里残留。

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, HardDrive, KeyRound, LockKeyhole } from "lucide-react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { router, useI18n } from "@keymaster/runtime";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  formatShortPublicKey,
  type CoordinatorCommandResult,
  type StorageRuntimeBucketV1
} from "@keymaster/contracts";
import { loadBuckets, toBinding, type BucketRow } from "./bucketCatalog.js";

/** 公开 Key 条目：只含列表展示所需字段，不含私钥材料。 */
interface BucketKeyEntry {
  publicKeyHex: string;
  label: string;
}

/** 单个桶的 Key 列表读取状态。 */
interface BucketKeyState {
  status: "idle" | "loading" | "ready" | "error";
  keys: BucketKeyEntry[];
  error?: string;
}

const IDLE: BucketKeyState = { status: "idle", keys: [] };

function probeOperationId(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 把 Coordinator 命令结果转成可展示错误；成功返回 null。 */
function commandError(result: CoordinatorCommandResult): string | null {
  if (result.status === "accepted" || result.status === "ok") return null;
  if ("message" in result) return result.message;
  if (result.status === "blocked") {
    return typeof result.reason === "string" ? result.reason : result.reason.fallback;
  }
  return `Switch failed: ${result.status}`;
}

/**
 * 顶栏切换组件。
 *
 * 数据来源：`keymaster.device.<ID>` 设备记录（桶清单） +
 * `keymaster.session`（activeBucketId / activeKey / 公开 KDF）。
 * 切换动作全部交给 Coordinator：同桶切 Key 走 vault.activateKey，
 * 跨桶走 storage.switchBucket（先验 Key 密码，成功后才安装运行态）。
 */
export function StorageSwitcherWidget() {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const keyspace = useOptionalCapability(KEYSPACE_SERVICE_CAPABILITY);

  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<BucketRow[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [bucketKeys, setBucketKeys] = useState<Record<string, BucketKeyState>>({});
  // 已输入并验证过桶密码的 s3 桶。仅存在于组件内存，切换成功 / 取消后清空。
  const [bucketSecrets, setBucketSecrets] = useState<Record<string, string>>({});
  const [activePublicKeyHex, setActivePublicKeyHex] = useState<string | undefined>();

  // 桶密码弹窗（s3 桶 -> 读取 Keys）。
  const [unlockBucket, setUnlockBucket] = useState<BucketRow | null>(null);
  const [bucketPassword, setBucketPassword] = useState("");
  const [bucketError, setBucketError] = useState<string | null>(null);
  const [bucketBusy, setBucketBusy] = useState(false);

  // Key 密码弹窗（选定 Key -> 激活 / 切换）。
  const [pendingKey, setPendingKey] = useState<{ row: BucketRow; key: BucketKeyEntry } | null>(null);
  const [keyPassword, setKeyPassword] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);

  const reload = useCallback(() => {
    try {
      setRows(loadBuckets());
      setCatalogError(null);
    } catch (error) {
      setRows([]);
      setCatalogError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    reload();
    const onStorage = () => reload();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);

  // 跨标签页 / 同一页面内的桶切换都会刷新桶清单。
  useEffect(() => {
    if (!storage) return;
    return storage.subscribe(reload);
  }, [storage, reload]);

  const currentBucketId = rows.find((row) => row.current)?.bucketId;

  /** 读取当前桶的 Keys：当前桶已解锁，直接用 vault 的公开列表。 */
  const loadCurrentKeys = useCallback(async () => {
    if (!vault || !currentBucketId || vault.status() !== "unlocked") return;
    try {
      const keys = await vault.listKeys();
      setBucketKeys((state) => ({
        ...state,
        [currentBucketId]: { status: "ready", keys: keys.map((key) => ({ publicKeyHex: key.publicKeyHex, label: key.label })) },
      }));
    } catch (error) {
      setBucketKeys((state) => ({
        ...state,
        [currentBucketId]: { status: "error", keys: [], error: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [vault, currentBucketId]);

  /** 只读探测 local 桶：local 无桶密码，Keys 可直接读取。 */
  const loadLocalKeys = useCallback(async (row: BucketRow) => {
    if (!storage?.probeBucket) return;
    setBucketKeys((state) => ({ ...state, [row.bucketId]: { status: "loading", keys: [] } }));
    try {
      const result = await storage.probeBucket({
        operationId: probeOperationId(),
        backend: "local",
        binding: toBinding(row),
      });
      if (!result.ok) {
        setBucketKeys((state) => ({ ...state, [row.bucketId]: { status: "error", keys: [], error: result.error.summary } }));
        return;
      }
      setBucketKeys((state) => ({
        ...state,
        [row.bucketId]: { status: "ready", keys: result.state === "has-keys" ? result.keys : [] },
      }));
    } catch (error) {
      setBucketKeys((state) => ({
        ...state,
        [row.bucketId]: { status: "error", keys: [], error: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, [storage]);

  // 当前桶 Keys 既用于面板也用于顶栏摘要；vault 解锁后持续同步。
  useEffect(() => {
    void loadCurrentKeys();
  }, [loadCurrentKeys]);

  // 面板打开时加载全部 local 非当前桶 Keys；s3 非当前桶必须先输入桶密码。
  useEffect(() => {
    if (!open) return;
    for (const row of rows) {
      if (!row.current && row.backend === "local") void loadLocalKeys(row);
    }
  }, [open, rows, loadLocalKeys]);

  // 订阅 active key：vault 生命周期 + keyspace。
  useEffect(() => {
    const sync = () => setActivePublicKeyHex(keyspace?.active().activePublicKeyHex ?? vault?.getLifecycleSnapshot().activePublicKeyHex);
    sync();
    const offKeyspace = keyspace?.onActiveKeyChanged((state) => setActivePublicKeyHex(state.activePublicKeyHex));
    const offVault = vault?.onLifecycleChange((snapshot) => {
      setActivePublicKeyHex(snapshot.activePublicKeyHex);
      if (snapshot.status === "unlocked") void loadCurrentKeys();
    });
    return () => {
      offKeyspace?.();
      offVault?.();
    };
  }, [keyspace, vault, loadCurrentKeys]);

  /** 清除全部内存密码与弹窗态。 */
  function clearSecrets() {
    setBucketSecrets({});
    setBucketPassword("");
    setKeyPassword("");
    setBucketError(null);
    setKeyError(null);
    // 已读取的非当前桶 Key 列表随桶密码一并回收，避免留下"已解锁"痕迹；
    // 下次打开面板时 local 桶会自动重新读取，s3 桶需重新输入桶密码。
    setBucketKeys((state) => {
      const next: Record<string, BucketKeyState> = {};
      for (const [id, value] of Object.entries(state)) {
        if (id === currentBucketId) next[id] = value;
      }
      return next;
    });
  }

  function closePanel() {
    setOpen(false);
    setUnlockBucket(null);
    setPendingKey(null);
    clearSecrets();
  }

  /** 点击桶：s3 非当前桶需要先输桶密码读 Keys；local / 当前桶无需动作。 */
  function pickBucket(row: BucketRow) {
    if (row.current) return;
    const state = bucketKeys[row.bucketId] ?? IDLE;
    if (row.backend === "local" || state.status === "ready") return;
    setUnlockBucket(row);
    setBucketPassword("");
    setBucketError(null);
  }

  async function submitBucketUnlock() {
    if (!unlockBucket || !storage?.probeBucket || bucketBusy) return;
    const row = unlockBucket;
    setBucketBusy(true);
    setBucketError(null);
    try {
      const result = await storage.probeBucket({
        operationId: probeOperationId(),
        backend: "s3",
        binding: toBinding(row),
        password: bucketPassword,
      });
      if (!result.ok) {
        setBucketError(result.error.summary);
        return;
      }
      if (result.state !== "has-keys") {
        setBucketError(t("storage.bucketManager.emptyBucket", { defaultValue: "该桶里没有可用的 Key。" }));
        return;
      }
      // 桶密码验证通过：只保存在本次切换流程的内存里。
      setBucketSecrets((state) => ({ ...state, [row.bucketId]: bucketPassword }));
      setBucketKeys((state) => ({ ...state, [row.bucketId]: { status: "ready", keys: result.keys } }));
      setUnlockBucket(null);
      setBucketPassword("");
    } catch (error) {
      setBucketError(error instanceof Error ? error.message : t("storage.bucketManager.err.bucketProbe", { defaultValue: "读取 Key 列表失败，请检查桶密码。" }));
    } finally {
      setBucketBusy(false);
    }
  }

  function pickKey(row: BucketRow, key: BucketKeyEntry) {
    if (row.current && key.publicKeyHex === activePublicKeyHex) {
      closePanel();
      return;
    }
    setPendingKey({ row, key });
    setKeyPassword("");
    setKeyError(null);
  }

  async function submitKeySwitch() {
    if (!pendingKey || !vault || !storage || keyBusy) return;
    const { row, key } = pendingKey;
    setKeyBusy(true);
    setKeyError(null);
    try {
      if (row.current) {
        // 同桶切 Key：不触碰桶会话，只验证并激活目标 Key。
        const result = await vault.activateKey({ publicKeyHex: key.publicKeyHex, password: keyPassword });
        const message = commandError(result);
        if (message) {
          setKeyError(message);
          return;
        }
      } else {
        const secret = row.backend === "s3" ? bucketSecrets[row.bucketId] : "";
        if (row.backend === "s3" && !secret) {
          setKeyError(t("storage.bucketManager.err.bucketNotUnlocked", { defaultValue: "请先输入桶密码读取该桶的 Keys。" }));
          return;
        }
        if (!storage.switchBucket) {
          setKeyError(t("storage.bucketManager.err.switchUnavailable", { defaultValue: "当前 Coordinator 不支持安全切桶，请刷新页面后重试。" }));
          return;
        }
        // 跨桶：Key 密码在 Worker 内先验证，失败时当前环境保持不变。
        await storage.switchBucket(toBinding(row), secret ?? "", { keyPassword, publicKeyHex: key.publicKeyHex });
      }
      // 成功：清除内存密码，进入新 Key 的 home 页面。
      clearSecrets();
      setPendingKey(null);
      setOpen(false);
      router.push("/");
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : t("storage.bucketManager.err.keySwitch", { defaultValue: "切换 Key 失败" }));
    } finally {
      setKeyPassword("");
      setKeyBusy(false);
    }
  }

  const currentRow = rows.find((row) => row.current);
  const currentKeys = currentBucketId ? bucketKeys[currentBucketId]?.keys ?? [] : [];
  const activeKey = activePublicKeyHex ? currentKeys.find((key) => key.publicKeyHex === activePublicKeyHex) : undefined;
  const unnamed = t("storage.bucketManager.unnamedKey", { defaultValue: "未命名 Key" });
  const unlocked = vault?.status() === "unlocked";

  return (
    <div className="storage-bucket-tree">
      <button
        type="button"
        data-testid="storage-switcher-trigger"
        className="storage-bucket-manager__topbar-entry storage-bucket-tree__trigger"
        onClick={() => (open ? closePanel() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("storage.bucketManager.topbar", { defaultValue: "存储桶" })}
        title={t("storage.bucketManager.topbar", { defaultValue: "存储桶" })}
      >
        <HardDrive size={14} aria-hidden="true" />
        <span>{currentRow?.label ?? t("storage.bucketManager.topbar", { defaultValue: "存储桶" })}</span>
        {activePublicKeyHex ? (
          <small className="storage-bucket-tree__trigger-key">
            {activeKey?.label || formatShortPublicKey(activePublicKeyHex)}
          </small>
        ) : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div className="storage-bucket-tree__panel" role="menu">
          <div className="storage-bucket-tree__heading">
            <span>{t("storage.bucketManager.treeTitle", { defaultValue: "桶 / Keys" })}</span>
            <button type="button" data-testid="storage-switcher-manage" onClick={() => { closePanel(); router.push("/storage/buckets"); }}>
              {t("storage.bucketManager.manage", { defaultValue: "管理" })}
            </button>
          </div>
          {catalogError ? <p className="storage-bucket-tree__hint is-error">{catalogError}</p> : null}
          {rows.length === 0 ? (
            <p className="storage-bucket-tree__hint">{t("storage.bucketManager.empty", { defaultValue: "还没有存储桶" })}</p>
          ) : rows.map((row) => {
            const state = bucketKeys[row.bucketId] ?? IDLE;
            const keyList = state.status === "ready" ? state.keys : [];
            return (
              <div key={row.bucketId} className={`storage-bucket-tree__bucket ${row.current ? "is-current" : ""}`} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="storage-bucket-tree__bucket-button"
                  onClick={() => pickBucket(row)}
                  disabled={bucketBusy && unlockBucket?.bucketId === row.bucketId}
                >
                  <HardDrive size={14} aria-hidden="true" />
                  <span>
                    <strong>{row.label}</strong>
                    <small>{row.backend === "local" ? "local" : "S3"}</small>
                  </span>
                  {row.current ? <small>{t("storage.bucketManager.selected", { defaultValue: "当前" })}</small> : null}
                </button>
                <div className="storage-bucket-tree__keys">
                  {state.status === "loading" ? (
                    <span>{t("common.status.loading", { defaultValue: "处理中…" })}</span>
                  ) : state.status === "error" ? (
                    <span className="storage-bucket-tree__hint is-error">{state.error}</span>
                  ) : keyList.length > 0 ? (
                    keyList.map((key) => {
                      const active = row.current && activePublicKeyHex === key.publicKeyHex;
                      return (
                        <button
                          key={key.publicKeyHex}
                          type="button"
                          data-testid={`storage-switcher-key-${key.publicKeyHex}`}
                          className={active ? "is-active" : undefined}
                          onClick={() => pickKey(row, key)}
                          aria-current={active ? "true" : undefined}
                        >
                          <KeyRound size={12} aria-hidden="true" />
                          <span>{key.label || unnamed}</span>
                          {active ? <><small>{t("storage.bucketManager.currentKey", { defaultValue: "当前" })}</small><Check size={12} aria-hidden="true" /></> : null}
                        </button>
                      );
                    })
                  ) : state.status === "ready" ? (
                    <span>{t("storage.bucketManager.noKeys", { defaultValue: "暂无 Keys" })}</span>
                  ) : row.backend === "s3" && !row.current ? (
                    <button type="button" onClick={() => pickBucket(row)}>
                      <LockKeyhole size={12} aria-hidden="true" />
                      <span>{t("storage.bucketManager.readKeys", { defaultValue: "输入密码读取 Keys" })}</span>
                    </button>
                  ) : !unlocked ? (
                    <span>{t("storage.bucketManager.lockedKeys", { defaultValue: "解锁后显示" })}</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <Modal
        open={unlockBucket !== null}
        title={t("storage.bucketManager.bucketUnlockTitle", { defaultValue: "输入桶密码读取 Keys" })}
        onClose={() => { setUnlockBucket(null); setBucketPassword(""); setBucketError(null); }}
        footer={(
          <Button variant="ghost" onClick={() => { setUnlockBucket(null); setBucketPassword(""); setBucketError(null); }} disabled={bucketBusy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
        )}
        data-testid="storage-switcher-bucket-unlock"
      >
        {unlockBucket ? (
          <p className="storage-bucket-tree__key-target">
            <strong>{unlockBucket.label}</strong>
            <code>{unlockBucket.backend === "local" ? "local" : "S3"}</code>
          </p>
        ) : null}
        <TextInput
          label={t("storage.bucketManager.bucketPassword", { defaultValue: "桶密码" })}
          type="password"
          autoComplete="current-password"
          value={bucketPassword}
          onChange={(event) => setBucketPassword(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submitBucketUnlock(); }}
          error={bucketError ?? undefined}
          disabled={bucketBusy}
          autoFocus
        />
        <Button onClick={() => void submitBucketUnlock()} loading={bucketBusy} disabled={!bucketPassword || bucketBusy}>
          {t("storage.bucketManager.readKeysSubmit", { defaultValue: "读取 Keys" })}
        </Button>
      </Modal>

      <Modal
        open={pendingKey !== null}
        title={t("storage.bucketManager.keySwitchTitle", { defaultValue: "切换 Key" })}
        onClose={() => { setPendingKey(null); setKeyPassword(""); setKeyError(null); }}
        footer={(
          <Button variant="ghost" onClick={() => { setPendingKey(null); setKeyPassword(""); setKeyError(null); }} disabled={keyBusy}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </Button>
        )}
        data-testid="storage-switcher-key-unlock"
      >
        {pendingKey ? (
          <p className="storage-bucket-tree__key-target">
            <strong>{pendingKey.key.label || unnamed}</strong>
            <code>{formatShortPublicKey(pendingKey.key.publicKeyHex)}</code>
          </p>
        ) : null}
        <TextInput
          label={t("storage.bucketManager.keyPassword", { defaultValue: "Key 密码" })}
          type="password"
          autoComplete="current-password"
          value={keyPassword}
          onChange={(event) => setKeyPassword(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submitKeySwitch(); }}
          error={keyError ?? undefined}
          disabled={keyBusy}
          autoFocus
        />
        <Button onClick={() => void submitKeySwitch()} loading={keyBusy} disabled={!keyPassword || keyBusy}>
          {t("storage.bucketManager.keySwitchSubmit", { defaultValue: "使用密码切换" })}
        </Button>
      </Modal>
    </div>
  );
}
