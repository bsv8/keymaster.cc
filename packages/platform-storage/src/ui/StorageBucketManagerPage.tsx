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
  type ExistingRemoteStorageConnectPlan,
  type StorageBucketConnectionConfigV1,
  type StorageRuntimeBucketV1
} from "@keymaster/contracts";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { router, useI18n, usePluginHost } from "@keymaster/runtime";
import { BucketConnectionFields } from "./BucketConnectionFields.js";
import { BucketKeyList } from "./BucketKeyList.js";
import { BucketSetupWizard } from "./BucketSetupWizard.js";
import { CurrentBucketKeyActions } from "./CurrentBucketKeyActions.js";
import { loadBuckets, toBinding, type BucketRow } from "./bucketCatalog.js";
import {
  EMPTY_BUCKET_DRAFT,
  connectionFromBucketDraft,
  updateBucketDraft,
  validateBucketDraft,
  type BucketDraft
} from "./bucketConnectionDraft.js";

// 桶目录读取集中在 bucketCatalog，这里保持原导出路径兼容（顶栏切换器与
// e2e 测试都从这里引用）。
export { loadBuckets } from "./bucketCatalog.js";
export type { BucketRow } from "./bucketCatalog.js";

export function StorageBucketManagerPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const service = useCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const [rows, setRows] = useState<BucketRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [pendingSwitch, setPendingSwitch] = useState<BucketRow | null>(null);
  // 条件写能力的手工重新探测（s3 桶；非当前桶需要桶密码）。
  const [reprobeTarget, setReprobeTarget] = useState<BucketRow | null>(null);
  const [reprobePassword, setReprobePassword] = useState("");
  const [reprobeError, setReprobeError] = useState<string | null>(null);
  const [reprobeBusy, setReprobeBusy] = useState(false);
  // 桶改名以“操作按钮 + 弹出框”进行，不再在页面底部挂一块表单。
  const [renameTarget, setRenameTarget] = useState<BucketRow | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
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
      ...(connectProbe.conditionalWrites === undefined ? {} : { capabilities: { conditionalWrites: connectProbe.conditionalWrites } }),
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

  function openRename(row: BucketRow): void {
    setRenameTarget(row);
    setRenameValue(row.label);
    setRenameError(null);
  }

  function closeRename(): void {
    if (renameBusy) return;
    setRenameTarget(null);
    setRenameValue("");
    setRenameError(null);
  }

  function openReprobe(row: BucketRow): void {
    if (row.current) {
      if (vault?.status() !== "unlocked") {
        setError(t("storage.bucketManager.err.reprobeLocked", { defaultValue: "请先解锁当前桶再重新探测条件写。" }));
        return;
      }
      void runCurrentBucketReprobe();
      return;
    }
    setReprobeTarget(row);
    setReprobePassword("");
    setReprobeError(null);
  }

  /** 当前桶已解锁：直接对运行态 Provider 做一次条件写探测并写回记录。 */
  async function runCurrentBucketReprobe(): Promise<void> {
    if (!service.probeConditionalCapabilities) {
      setError(t("storage.bucketManager.err.reprobe", { defaultValue: "当前 Coordinator 不支持条件写探测。" }));
      return;
    }
    setBusyId("reprobe");
    setError(null);
    try {
      await service.probeConditionalCapabilities();
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("storage.bucketManager.err.reprobe", { defaultValue: "重新探测条件写失败。" }));
    } finally {
      setBusyId(null);
    }
  }

  function closeReprobe(): void {
    if (reprobeBusy) return;
    setReprobeTarget(null);
    setReprobePassword("");
    setReprobeError(null);
  }

  /** 非当前 s3 桶：用桶密码建立只读连接并强制重新探测，结果写回设备记录。 */
  async function submitReprobe(): Promise<void> {
    if (!reprobeTarget || !service.probeBucket || reprobeBusy) return;
    const row = reprobeTarget;
    setReprobeBusy(true);
    setReprobeError(null);
    try {
      const result = await service.probeBucket({
        operationId: "reprobe-" + Date.now().toString(36),
        backend: "s3",
        binding: toBinding(row),
        password: reprobePassword,
        forceReprobe: true,
      });
      if (!result.ok) {
        setReprobeError(result.error.summary);
        return;
      }
      setReprobeTarget(null);
      setReprobePassword("");
      reload();
    } catch (err) {
      setReprobeError(err instanceof Error ? err.message : t("storage.bucketManager.err.reprobe", { defaultValue: "重新探测条件写失败。" }));
    } finally {
      setReprobeBusy(false);
    }
  }

  async function submitRename(): Promise<void> {
    if (!renameTarget || !service.renameBucket || renameBusy) return;
    const label = renameValue.trim();
    if (!label) {
      setRenameError(t("storage.bucketManager.err.renameEmpty", { defaultValue: "请输入桶名称。" }));
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await service.renameBucket(label);
      setRenameTarget(null);
      setRenameValue("");
      reload();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : t("storage.bucketManager.err.rename", { defaultValue: "修改桶名称失败" }));
    } finally {
      setRenameBusy(false);
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
              <div className="storage-bucket-manager__row-head">
                <div className="storage-bucket-manager__meta">
                  <strong>{row.label}</strong>
                  <code>{row.bucketId}</code>
                  <span>{row.backend}</span>
                  {row.backend === "s3" ? (
                    <span
                      className={`storage-bucket-manager__capability storage-bucket-manager__capability--${row.conditionalWrites ?? "unknown"}`}
                      data-testid={`bucket-capability-${row.bucketId}`}
                    >
                      {row.conditionalWrites === "native"
                        ? t("storage.bucketManager.capability.native", { defaultValue: "原生条件写" })
                        : row.conditionalWrites === "best-effort"
                          ? t("storage.bucketManager.capability.bestEffort", { defaultValue: "模拟条件写" })
                          : t("storage.bucketManager.capability.unknown", { defaultValue: "未探测" })}
                    </span>
                  ) : null}
                  {row.current ? <span data-testid="bucket-current">{t("storage.bucketManager.current", { defaultValue: "当前" })}</span> : null}
                </div>
                <div className="storage-bucket-manager__row-actions">
                  {row.backend === "s3" ? (
                    <button
                      type="button"
                      data-testid={`bucket-reprobe-${row.bucketId}`}
                      disabled={busyId !== null}
                      onClick={() => openReprobe(row)}
                    >
                      {t("storage.bucketManager.reprobe", { defaultValue: "重新探测条件写" })}
                    </button>
                  ) : null}
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
                    <>
                      <button
                        type="button"
                        data-testid="bucket-rename-open"
                        onClick={() => openRename(row)}
                        disabled={busyId !== null}
                      >
                        {t("storage.bucketManager.rename", { defaultValue: "改名" })}
                      </button>
                      {/* Key 管理只对当前桶提供：非当前桶必须先切换解锁。 */}
                      <CurrentBucketKeyActions
                        bucketLabel={row.label}
                        unlocked={vault?.status() === "unlocked"}
                        onChanged={reload}
                      />
                    </>
                  )}
                </div>
              </div>
              {/* 当前桶与非当前 Local 桶都直接列出 Key（Local 权限在本机）； 
                  非当前 S3 桶的读取入口在顶栏切换器。 */}
              <BucketKeyList row={row} unlocked={vault?.status() === "unlocked"} onChanged={reload} />
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
      <Modal
        open={reprobeTarget !== null}
        title={t("storage.bucketManager.reprobeTitle", { defaultValue: "重新探测条件写能力" })}
        onClose={closeReprobe}
        footer={(
          <>
            <Button variant="ghost" onClick={closeReprobe} disabled={reprobeBusy}>
              {t("common.action.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={() => void submitReprobe()} loading={reprobeBusy} disabled={!reprobePassword}>
              {t("storage.bucketManager.reprobeSubmit", { defaultValue: "开始探测" })}
            </Button>
          </>
        )}
        data-testid="bucket-reprobe-modal"
      >
        <p className="storage-bucket-manager__key-hint">
          {t("storage.bucketManager.reprobeHint", { defaultValue: "输入该桶的桶密码，仅用于本次探测；结果会写回本机记录，之后不再自动探测。" })}
          {reprobeTarget ? <> <code>{reprobeTarget.label}</code></> : null}
        </p>
        <TextInput
          label={t("storage.bucketManager.bucketPassword", { defaultValue: "桶密码" })}
          type="password"
          autoComplete="current-password"
          value={reprobePassword}
          onChange={(event) => { setReprobePassword(event.currentTarget.value); setReprobeError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") void submitReprobe(); }}
          error={reprobeError ?? undefined}
          autoFocus
        />
      </Modal>

      <Modal
        open={renameTarget !== null}
        title={t("storage.bucketManager.renameTitle", { defaultValue: "重命名存储桶" })}
        onClose={closeRename}
        footer={(
          <>
            <Button variant="ghost" onClick={closeRename} disabled={renameBusy}>
              {t("common.action.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={() => void submitRename()} loading={renameBusy} disabled={!renameValue.trim()}>
              {t("storage.bucketManager.renameSubmit", { defaultValue: "保存名称" })}
            </Button>
          </>
        )}
        data-testid="bucket-rename-modal"
      >
        <TextInput
          label={t("storage.bucketManager.renameField", { defaultValue: "新的桶名称" })}
          value={renameValue}
          onChange={(event) => { setRenameValue(event.currentTarget.value); setRenameError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); }}
          error={renameError ?? undefined}
          placeholder={renameTarget?.label ?? ""}
          autoFocus
        />
      </Modal>
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
