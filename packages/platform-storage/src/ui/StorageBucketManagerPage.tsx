// packages/platform-storage/src/ui/StorageBucketManagerPage.tsx
// 桶管理页（硬切换后的最小版本）。
//
// 数据来源：
//   - 本机桶清单 = `keymaster.device.<ID>` 记录（一桶一条）；
//   - 当前桶 = `keymaster.session` 的 activeBucketId；
//   - 切换/改名走 Coordinator 控制面（StorageRuntimeController），
//     切换 s3 桶需要输入启动密码解密连接参数。

import { useCallback, useEffect, useState } from "react";
import { useCapability, useOptionalCapability } from "webloom-framework/react";
import {
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type BucketProbeResult,
  type DeviceRecordV1,
  type ExistingRemoteStorageConnectPlan,
  type StorageBucketConnectionConfigV1,
  type StorageRuntimeBucketV1
} from "@keymaster/contracts";
import { Modal } from "@keymaster/ui";
import { router, useI18n, usePluginHost } from "@keymaster/runtime";
import { createDeviceRecordRepository, defaultDeviceStorage, readSession } from "../index.js";
import { BucketConnectionFields } from "./BucketConnectionFields.js";
import { BucketSetupWizard } from "./BucketSetupWizard.js";
import { CurrentBucketKeyActions } from "./CurrentBucketKeyActions.js";
import {
  EMPTY_BUCKET_DRAFT,
  connectionFromBucketDraft,
  updateBucketDraft,
  validateBucketDraft,
  type BucketDraft
} from "./bucketConnectionDraft.js";

export interface BucketRow {
  bucketId: string;
  label: string;
  backend: "local" | "s3";
  record: DeviceRecordV1;
  current: boolean;
}

export function loadBuckets(): BucketRow[] {
  const storage = defaultDeviceStorage();
  const session = readSession(storage);
  const { entries } = createDeviceRecordRepository(storage).list();
  return entries
    .map((entry) => ({
      bucketId: entry.remoteStorageId,
      label: entry.record.displayName ?? entry.remoteStorageId,
      backend: entry.record.location.providerId,
      record: entry.record,
      current: session?.activeBucketId === entry.remoteStorageId,
    }))
    .sort((left, right) => Number(right.current) - Number(left.current) || left.label.localeCompare(right.label));
}

function toBinding(row: BucketRow): StorageRuntimeBucketV1 {
  const session = readSession(defaultDeviceStorage());
  return {
    bucketId: row.bucketId,
    backend: row.backend,
    label: row.label,
    deviceRecord: row.record,
    ...(row.backend === "s3" && session?.keyDerivation ? { keyDerivation: session.keyDerivation } : {}),
  };
}

export function StorageBucketManagerPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const service = useCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const [rows, setRows] = useState<BucketRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pendingSwitch, setPendingSwitch] = useState<BucketRow | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 新建桶：页内 Modal 分步向导，与初始化共用同一业务状态机。
  const [setupOpen, setSetupOpen] = useState(false);
  // 连接已有桶（本页新增入口）：探测 → 选 Key + 密码 → 连接。
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectDraft, setConnectDraft] = useState<BucketDraft>(() => ({ ...EMPTY_BUCKET_DRAFT }));
  const [connectNamespace, setConnectNamespace] = useState("");
  const [connectProbe, setConnectProbe] = useState<BucketProbeResult | undefined>();
  const [connectConnection, setConnectConnection] = useState<StorageBucketConnectionConfigV1 | undefined>();
  const [connectKeyHex, setConnectKeyHex] = useState<string | undefined>();
  const [connectKeyPassword, setConnectKeyPassword] = useState("");
  const [connectStartupPassword, setConnectStartupPassword] = useState("");

  const reload = useCallback(() => {
    try {
      setRows(loadBuckets());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    reload();
    try {
      // storage.status 变化（切桶/改名）后刷新本机桶清单。
      return host.resourceStore.subscribe("storage.status", [], () => reload());
    } catch {
      return undefined;
    }
  }, [host, reload]);

  const current = rows.find((row) => row.current);

  async function switchTo(row: BucketRow, secret: string): Promise<void> {
    if (!service.switchBucket) throw new Error("Storage control does not support bucket switching");
    setBusyId(row.bucketId);
    setError(null);
    try {
      await service.switchBucket(toBinding(row), secret);
      setPendingSwitch(null);
      setPassword("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function resetConnectPanel(): void {
    setConnectDraft({ ...EMPTY_BUCKET_DRAFT });
    setConnectNamespace("");
    setConnectProbe(undefined);
    setConnectConnection(undefined);
    setConnectKeyHex(undefined);
    setConnectKeyPassword("");
    setConnectStartupPassword("");
    setError(null);
  }

  function updateConnectDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]): void {
    setConnectDraft((current) => updateBucketDraft(current, key, value));
    setConnectProbe(undefined);
    setConnectConnection(undefined);
    setError(null);
  }

  /** 探测已有桶：只读 keys/,判定是否可连接。 */
  async function probeExistingBucket(): Promise<void> {
    if (!service.probeBucket) { setError("存储探测不可用"); return; }
    const invalid = validateBucketDraft(connectDraft);
    if (invalid) { setError(invalid.message); return; }
    if (connectDraft.backend === "local" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(connectNamespace.trim())) {
      setError("Namespace（本机桶 ID）格式无效");
      return;
    }
    let connection: StorageBucketConnectionConfigV1;
    try {
      connection = connectionFromBucketDraft(connectDraft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (connection.kind !== "s3" && connectDraft.backend !== "local") { setError("连接参数不完整"); return; }
    setBusyId("connect");
    setError(null);
    try {
      const result = await service.probeBucket({
        operationId: "probe-" + Date.now().toString(36),
        backend: connectDraft.backend,
        connection,
        ...(connectDraft.backend === "local" ? { remoteStorageId: connectNamespace.trim() } : {}),
      });
      setConnectProbe(result);
      setConnectConnection(connection);
      if (result.ok && result.state === "has-keys") setConnectKeyHex(result.keys[0]?.publicKeyHex);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      setConnectStartupPassword("");
    }
  }

  /** 连接已有桶：写本机记录 + session 并接管运行态。 */
  async function submitExistingBucket(): Promise<void> {
    if (!service.connectExistingRemote || !connectProbe || !connectProbe.ok || connectProbe.state !== "has-keys" || !connectConnection) return;
    const plan: ExistingRemoteStorageConnectPlan = {
      operationId: "connect-" + Date.now().toString(36),
      ...(connectDraft.backend === "local" ? { remoteStorageId: connectNamespace.trim() } : {}),
      displayName: connectDraft.label.trim() || connectNamespace.trim() || "钱包",
      backend: connectDraft.backend,
      connection: connectConnection,
      ...(connectKeyHex === undefined ? {} : { publicKeyHex: connectKeyHex }),
      keyPassword: connectKeyPassword,
      ...(connectDraft.backend === "s3" ? { startupPassword: connectStartupPassword } : {}),
    };
    setBusyId("connect");
    setError(null);
    try {
      const result = await service.connectExistingRemote(plan);
      if (!result.ok) { setError(result.error.summary); return; }
      resetConnectPanel();
      setConnectOpen(false);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      setConnectKeyPassword("");
      setConnectStartupPassword("");
    }
  }

  async function renameCurrent(): Promise<void> {
    const label = renameLabel.trim();
    if (!label || !service.renameBucket) return;
    setBusyId("rename");
    setError(null);
    try {
      await service.renameBucket(label);
      setRenameLabel("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="storage-bucket-manager" data-testid="storage-buckets">
      <header className="storage-bucket-manager__head">
        <h1>{t("storage.bucketManager.title", { defaultValue: "存储桶管理" })}</h1>
        <button type="button" onClick={reload}>
          {t("storage.bucketManager.refresh", { defaultValue: "刷新" })}
        </button>
        <button
          type="button"
          data-testid="bucket-setup-toggle"
          onClick={() => setSetupOpen(true)}
        >
          {t("storage.bucketManager.addBucket", { defaultValue: "添加存储桶" })}
        </button>
        <button
          type="button"
          data-testid="connect-existing-toggle"
          onClick={() => { setConnectOpen((open) => !open); if (connectOpen) resetConnectPanel(); }}
        >
          {t("storage.bucketManager.connectExisting", { defaultValue: "连接已有桶" })}
        </button>
      </header>
      {error ? <p className="storage-bucket-manager__error" role="alert">{error}</p> : null}
      {rows.length === 0 ? (
        <p>{t("storage.bucketManager.empty", { defaultValue: "本机还没有登记任何存储桶。" })}</p>
      ) : (
        <ul className="storage-bucket-manager__list">
          {rows.map((row) => (
            <li key={row.bucketId} className="storage-bucket-manager__row" data-testid={`bucket-row-${row.bucketId}`}>
              <div className="storage-bucket-manager__meta">
                <strong>{row.label}</strong>
                <code>{row.bucketId}</code>
                <span>{row.backend}</span>
                {row.current ? <span data-testid="bucket-current">{t("storage.bucketManager.current", { defaultValue: "当前" })}</span> : null}
              </div>
              {!row.current ? (
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => {
                    if (row.backend === "s3") {
                      setPendingSwitch(row);
                      return;
                    }
                    void switchTo(row, "");
                  }}
                >
                  {t("storage.bucketManager.switch", { defaultValue: "切换到此桶" })}
                </button>
              ) : (
                // Key 管理只对当前桶提供：非当前桶必须先切换解锁。
                <CurrentBucketKeyActions
                  bucketLabel={row.label}
                  unlocked={vault?.status() === "unlocked"}
                  onChanged={reload}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {pendingSwitch ? (
        <section className="storage-bucket-manager__password" data-testid="bucket-switch-password">
          <label>
            {t("storage.bucketManager.startupPassword", { defaultValue: "启动密码（该桶连接参数）" })}
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            disabled={busyId !== null || password.length === 0}
            onClick={() => void switchTo(pendingSwitch, password)}
          >
            {t("storage.bucketManager.confirmSwitch", { defaultValue: "确认切换" })}
          </button>
          <button type="button" onClick={() => { setPendingSwitch(null); setPassword(""); }}>
            {t("common.action.cancel", { defaultValue: "取消" })}
          </button>
        </section>
      ) : null}
      {connectOpen ? (
        <section className="storage-bucket-manager__connect" data-testid="connect-existing-panel">
          <h2>{t("storage.bucketManager.connectExisting", { defaultValue: "连接已有桶" })}</h2>
          <BucketConnectionFields draft={connectDraft} onChange={updateConnectDraft} section="parameters" />
          {connectDraft.backend === "local" ? (
            <label>
              {t("storage.bucketManager.namespace", { defaultValue: "Namespace（本机桶 ID）" })}
              <input
                value={connectNamespace}
                onChange={(event) => { setConnectNamespace(event.currentTarget.value.trim()); setConnectProbe(undefined); setConnectConnection(undefined); setError(null); }}
              />
            </label>
          ) : null}
          <button type="button" data-testid="probe-existing" disabled={busyId !== null} onClick={() => void probeExistingBucket()}>
            {t("storage.bucketManager.probe", { defaultValue: "探测目标桶" })}
          </button>
          {connectProbe && !connectProbe.ok ? <p role="alert">{connectProbe.error.summary}</p> : null}
          {connectProbe?.ok && connectProbe.state === "empty" ? (
            <p role="status">{t("storage.bucketManager.emptyTarget", { defaultValue: "该桶还没有任何 Key；新增空桶请使用初始化流程。" })}</p>
          ) : null}
          {connectProbe?.ok && connectProbe.state === "has-keys" ? (
            <>
              <ul className="storage-bucket-manager__keys">
                {connectProbe.keys.map((key) => (
                  <li key={key.publicKeyHex}>
                    <button
                      type="button"
                      aria-pressed={connectKeyHex === key.publicKeyHex}
                      onClick={() => { setConnectKeyHex(key.publicKeyHex); setError(null); }}
                    >
                      {key.label || key.publicKeyHex.slice(0, 10)}
                    </button>
                  </li>
                ))}
              </ul>
              <label>
                {t("storage.bucketManager.keyPassword", { defaultValue: "该 Key 自己的密码" })}
                <input
                  type="password"
                  value={connectKeyPassword}
                  onChange={(event) => setConnectKeyPassword(event.currentTarget.value)}
                />
              </label>
              {connectDraft.backend === "s3" ? (
                <label>
                  {t("storage.bucketManager.startupPassword", { defaultValue: "启动密码（保存本机连接参数）" })}
                  <input
                    type="password"
                    value={connectStartupPassword}
                    onChange={(event) => setConnectStartupPassword(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              <button
                type="button"
                data-testid="submit-existing"
                disabled={busyId !== null || connectKeyHex === undefined || connectKeyPassword.length < 8 || (connectDraft.backend === "s3" && connectStartupPassword.length < 8)}
                onClick={() => void submitExistingBucket()}
              >
                {t("storage.bucketManager.connect", { defaultValue: "连接并接管" })}
              </button>
            </>
          ) : null}
        </section>
      ) : null}
      {current ? (
        <section className="storage-bucket-manager__rename" data-testid="bucket-rename">
          <label>
            {t("storage.bucketManager.renameLabel", { defaultValue: "当前桶显示名称" })}
            <input
              value={renameLabel}
              placeholder={current.label}
              onChange={(event) => setRenameLabel(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            disabled={busyId !== null || renameLabel.trim().length === 0}
            onClick={() => void renameCurrent()}
          >
            {t("storage.bucketManager.rename", { defaultValue: "改名" })}
          </button>
        </section>
      ) : null}
      <Modal
        open={setupOpen}
        title={t("storage.bucketManager.addBucket", { defaultValue: "添加存储桶" })}
        onClose={() => setSetupOpen(false)}
        data-testid="bucket-setup-modal"
      >
        {setupOpen ? (
          <BucketSetupWizard
            variant="modal"
            onCancel={() => setSetupOpen(false)}
            onDone={() => {
              // 新建桶会安装并解锁新桶运行态；与初始化一致直接进入 home。
              setSetupOpen(false);
              reload();
              router.push("/");
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
