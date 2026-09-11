import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Check, ChevronDown, HardDrive, KeyRound, LockKeyhole, MoreHorizontal, Plus } from "lucide-react";
import { KEYSPACE_SERVICE_CAPABILITY, STORAGE_RUNTIME_CONTROLLER_CAPABILITY, VAULT_SERVICE_CAPABILITY, formatShortPublicKey, type ActiveKeyState, type KeyRef, type StorageBootstrapState, type StorageBucketCatalogEntryV2, type StorageBucketConnectionConfigV1, type StorageCatalogV2, type VaultService } from "@keymaster/contracts";
import { Button, Modal, PageHeader, TextInput } from "@keymaster/ui";
import { router, useI18n } from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import { createStorageBucketManagementService } from "../hold/storageBucketManagement.js";
import { exportStorageProfileEnvelope, readLegacyStorageBootstrap } from "../bootstrap/storageProfileRepository.js";
import { readStorageCatalog } from "../bootstrap/storageCatalogRepository.js";
import { BucketConnectionFields, EMPTY_BUCKET_DRAFT, bucketDraftFingerprint, connectionFromBucketDraft, createBucketProvider, updateBucketDraft, validateBucketDraft, type BucketDraft } from "./BucketConnectionFields.js";

const EMPTY_CATALOG: StorageCatalogV2 = {
  format: "keymaster.storage.catalog",
  version: 2,
  buckets: []
};

function readCatalogState(): { catalog: StorageCatalogV2; error?: string } {
  try {
    return { catalog: readStorageCatalog() };
  } catch (error) {
    // 目录损坏或 localStorage 被禁用时不能伪装成“没有桶”；用空视图只
    // 为了让页面能显示错误，所有写操作仍会被 catalogError 阻止。
    return {
      catalog: EMPTY_CATALOG,
      error: error instanceof Error ? error.message : "Storage catalog is unavailable"
    };
  }
}

function readLegacyState(): { state: StorageBootstrapState | null; error?: string } {
  try {
    return { state: readLegacyStorageBootstrap() };
  } catch (error) {
    // 旧记录损坏也必须显式显示，不能把它当成“没有旧数据”从而让用户
    // 误以为切换到新版桶已经完成。
    return { state: null, error: error instanceof Error ? error.message : "Legacy storage bootstrap is invalid" };
  }
}

function draftFromConnection(entry: StorageBucketCatalogEntryV2, config: StorageBucketConnectionConfigV1, password: string): BucketDraft {
  return config.kind === "local"
    ? { ...EMPTY_BUCKET_DRAFT, editingBucketId: entry.bucketId, label: entry.label, password, passwordConfirm: password }
    : {
      ...EMPTY_BUCKET_DRAFT,
      editingBucketId: entry.bucketId,
      label: entry.label,
      backend: "s3",
      // 新版目录只保存最终通用 S3 连接，无法可靠恢复当初使用的
      // AWS/R2 页面模板；编辑统一以普通 S3-compatible 打开，禁止猜测。
      s3ConfigMode: "s3-compatible",
      password,
      passwordConfirm: password,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken ?? "",
      prefix: config.prefix ?? "",
      forcePathStyle: config.forcePathStyle === true
    };
}

function download(name: string, bytes: Uint8Array): void {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy.buffer], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 外层存储桶管理页。
 *
 * 该页面只读/写本机桶目录和已提交的桶快照，不把 Keys 列表复制到目录。
 * 配置保存采用明确的“测试 → 保存”流程；测试结果一旦草稿变化就失效。
 */
export function StorageBucketManagerPage() {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const manager = useMemo(() => {
    try { return createStorageBucketManagementService(); }
    catch { return undefined; }
  }, []);
  const [catalogState, setCatalogState] = useState(readCatalogState);
  const catalog = catalogState.catalog;
  const catalogError = catalogState.error;
  const [legacyState, setLegacyState] = useState(readLegacyState);
  const legacyBootstrap = legacyState.state;
  const legacyError = legacyState.error;
  const [legacyKeys, setLegacyKeys] = useState<KeyRef[]>([]);
  const [draft, setDraft] = useState<BucketDraft>(EMPTY_BUCKET_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [keys, setKeys] = useState<KeyRef[]>([]);
  const [activePublicKeyHex, setActivePublicKeyHex] = useState<string | undefined>();
  const [pendingKey, setPendingKey] = useState<KeyRef | null>(null);
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "import" | "edit" | "change-password" | "switch" | "export" | "rename" | "remove" | "destroy" | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState(storage?.status() ?? "unconfigured");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const vaultStatus = vault?.status();

  const reload = useCallback(() => {
    setCatalogState(readCatalogState());
    setLegacyState(readLegacyState());
  }, []);

  useEffect(() => {
    const onStorage = () => reload();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);

  useEffect(() => {
    if (!storage) return;
    setRuntimeStatus(storage.status());
    return storage.subscribe(() => setRuntimeStatus(storage.status()));
  }, [storage]);

  useEffect(() => {
    // 只在旧 bootstrap 仍是当前启动来源时读取旧 Key 元数据。若新版
    // 目录已经存在，Worker 不会绑定旧 OPFS；此时不能把新版 Keys 误显示
    // 成旧桶 Keys，只保留迁移/导出提示。
    if (!legacyBootstrap || !vault || catalog.buckets.length > 0) {
      setLegacyKeys([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const keys = await vault.listKeys();
        if (!cancelled) setLegacyKeys(keys);
      } catch {
        if (!cancelled) setLegacyKeys([]);
      }
    };
    void load();
    const unsubscribe = vault.onLifecycleChange(() => { void load(); });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [catalog.buckets.length, legacyBootstrap, vault]);

  useEffect(() => {
    if (!vault || vault.status() !== "unlocked") {
      setKeys([]);
      setActivePublicKeyHex(undefined);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const next = await vault.listKeys();
        if (!cancelled) {
          setKeys(next);
          setActivePublicKeyHex(vault.getLifecycleSnapshot().activePublicKeyHex);
        }
      } catch {
        if (!cancelled) setKeys([]);
      }
    };
    void load();
    const unsubscribe = vault.onLifecycleChange(() => { void load(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [vault, runtimeStatus]);

  function updateDraft<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]) {
    setDraft((current) => updateBucketDraft(current, key, value));
    setTestedFingerprint(null);
    setMessage(null);
  }

  function validateDraft(): string | undefined {
    if (!draft.label.trim()) return t("storage.bucketManager.err.label", { defaultValue: "请输入桶名称" });
    if (draft.password.length < 8) return t("storage.bucketManager.err.password", { defaultValue: "桶密码至少 8 位" });
    if (draft.password !== draft.passwordConfirm) return t("storage.bucketManager.err.passwordMismatch", { defaultValue: "两次桶密码不一致" });
    const invalid = validateBucketDraft(draft);
    if (invalid) return t(`storage.bucketManager.err.${invalid.code}`, { defaultValue: invalid.message });
    return undefined;
  }

  async function testDraft() {
    const invalid = validateDraft();
    if (invalid) { setMessage({ kind: "error", text: invalid }); return; }
    setBusy("test"); setMessage(null);
    let provider: ReturnType<typeof createBucketProvider> | undefined;
    try {
      // 新建桶测试必须沿用当前草稿的字段语义；转换后的通用连接只用于
      // 保存/提交，不能在这里把模板信息提前丢掉。
      provider = createBucketProvider(draft, `test-${crypto.randomUUID()}`);
      const result = await provider.probe();
      if (!result.ok || result.conditionalWrites !== "native") throw new Error(t("storage.bucketManager.err.conditionalWrites", { defaultValue: "桶不支持必须的原子条件写入" }));
      setTestedFingerprint(bucketDraftFingerprint(draft));
      setMessage({ kind: "success", text: t("storage.bucketManager.tested", { defaultValue: "测试成功。草稿未改变时可以保存。" }) });
    } catch (error) {
      setTestedFingerprint(null);
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.test", { defaultValue: "桶测试失败，请检查配置后重试" }) });
    } finally {
      provider?.dispose();
      setBusy(null);
    }
  }

  async function saveDraft() {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    const invalid = validateDraft();
    if (invalid) { setMessage({ kind: "error", text: invalid }); return; }
    if (testedFingerprint !== bucketDraftFingerprint(draft)) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.testFirst", { defaultValue: "请先测试当前草稿；修改参数后需要重新测试" }) });
      return;
    }
    setBusy("save"); setMessage(null);
    try {
      const config = connectionFromBucketDraft(draft);
      if (draft.editingBucketId) {
        const entry = catalog.buckets.find((item) => item.bucketId === draft.editingBucketId);
        if (!entry) throw new Error("The bucket being edited no longer exists");
        if (catalog.selectedBucketId === entry.bucketId) {
          if (!storage?.changeBucketConnectionConfig) throw new Error("当前桶配置必须通过 Coordinator 保存，请刷新页面后重试");
          // 当前桶的 Provider、Hold 快照、目录 CAS 和运行时必须同一处
          // 提交；页面不能先直接改 localStorage 再通知 Worker。
          await storage.changeBucketConnectionConfig(config, draft.password, draft.label.trim());
        } else {
          const oldConfig = await manager.unlockBucketConfig(entry, draft.password);
          const oldProvider = createBucketProvider(oldConfig, entry.bucketId);
          const nextProvider = createBucketProvider(draft, entry.bucketId);
          try {
            await manager.changeBucketConnectionConfig({
              entry,
              provider: oldProvider,
              nextProvider,
              config,
              password: draft.password,
              label: draft.label.trim(),
              bucketGeneration: 1
            });
          } finally {
            oldProvider.dispose();
            nextProvider.dispose();
          }
        }
      } else {
        await manager.prepareBucketConfig(config, draft.password, {
          label: draft.label.trim(),
          backend: draft.backend,
          createProvider: (bucketId) => createBucketProvider(draft, bucketId),
          bucketGeneration: 1
        });
      }
      reload();
      setDraft(EMPTY_BUCKET_DRAFT);
      setEditorOpen(false);
      setTestedFingerprint(null);
      setReloadRequired(true);
      setMessage({ kind: "success", text: t("storage.bucketManager.saved", { defaultValue: "存储桶已保存到本机目录" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.save", { defaultValue: "保存失败，请保留草稿并重试" }) });
    } finally { setBusy(null); }
  }

  async function editBucket(entry: StorageBucketCatalogEntryV2) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    let password = window.prompt(t("storage.bucketManager.editPassword", { defaultValue: "输入当前桶密码以编辑连接配置" }));
    if (!password) return;
    setBusy("edit"); setMessage(null);
    try {
      const config = await manager.unlockBucketConfig(entry, password);
      setDraft(draftFromConnection(entry, config, password));
      setEditorOpen(true);
      setTestedFingerprint(null);
      setMessage({ kind: "success", text: t("storage.bucketManager.editLoaded", { defaultValue: "配置已读取。修改后请重新测试，再保存。" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.edit", { defaultValue: "读取桶配置失败，请检查密码" }) });
      password = "";
    } finally {
      password = "";
      setBusy(null);
    }
  }

  async function importBucketFromFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !manager || catalogError) {
      if (catalogError) setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    const suggestedLabel = file.name.replace(/\.keymaster\.hold\.json$/iu, "").trim() || "导入的存储桶";
    const label = window.prompt(t("storage.bucketManager.importLabel", { defaultValue: "输入导入桶名称" }), suggestedLabel)?.trim();
    if (!label) return;
    let password = window.prompt(t("storage.bucketManager.importPassword", { defaultValue: "输入 Hold 文件密码" }));
    if (!password) return;
    setBusy("import"); setMessage(null);
    try {
      const document = await file.text();
      await manager.importBucketDocument({
        document,
        password,
        label,
        createProvider: createBucketProvider
      });
      reload();
      setReloadRequired(true);
      setMessage({ kind: "success", text: t("storage.bucketManager.imported", { defaultValue: "Hold 配置已验证并导入；重新加载后进入该桶。" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.import", { defaultValue: "导入失败，请检查文件和密码" }) });
    } finally {
      // 尽力释放当前函数持有的密码引用；SDK CryptoContext 已在服务中
      // finally dispose，输入框也没有保存该密码。
      password = "";
      setBusy(null);
    }
  }

  async function changeBucketPassword(entry: StorageBucketCatalogEntryV2) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    let oldPassword = window.prompt(t("storage.bucketManager.oldPassword", { defaultValue: "输入当前桶密码" }));
    if (!oldPassword) return;
    let newPassword = window.prompt(t("storage.bucketManager.newPassword", { defaultValue: "输入新的桶密码（至少 8 位）" }));
    if (!newPassword) { oldPassword = ""; return; }
    const confirmation = window.prompt(t("storage.bucketManager.newPasswordConfirm", { defaultValue: "再次输入新的桶密码" }));
    if (confirmation !== newPassword) {
      oldPassword = ""; newPassword = "";
      setMessage({ kind: "error", text: t("storage.bucketManager.err.passwordMismatch", { defaultValue: "两次桶密码不一致" }) });
      return;
    }
    if (newPassword.length < 8) {
      oldPassword = ""; newPassword = "";
      setMessage({ kind: "error", text: t("storage.bucketManager.err.password", { defaultValue: "桶密码至少 8 位" }) });
      return;
    }
    setBusy("change-password"); setMessage(null);
    let provider: ReturnType<typeof createBucketProvider> | undefined;
    try {
      if (catalog.selectedBucketId === entry.bucketId) {
        if (runtimeStatus !== "ready" || !storage?.changeBucketPassword) {
          throw new Error("Select and unlock this bucket before changing its password");
        }
        // 当前桶的 Worker 还要同时旋转 canonical Vault meta/Key records，
        // 所以必须走 Coordinator 的跨存储事务；页面不直接碰当前会话。
        await storage.changeBucketPassword(oldPassword, newPassword);
      } else {
        // 未选中的桶没有当前会话，可在本次管理操作中短暂解密其配置，
        // 由无状态管理服务旋转该桶已提交快照并 CAS 更新本机目录。
        const config = await manager.unlockBucketConfig(entry, oldPassword);
        provider = createBucketProvider(config, entry.bucketId);
        await manager.changeBucketPassword({ entry, provider, oldPassword, newPassword });
      }
      reload();
      setReloadRequired(true);
      setMessage({ kind: "success", text: t("storage.bucketManager.passwordChanged", { defaultValue: "桶密码和全部 Key 快照已更新；重新加载后使用新密码。" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.passwordChange", { defaultValue: "桶密码修改失败，旧密码仍然有效" }) });
    } finally {
      oldPassword = "";
      newPassword = "";
      provider?.dispose();
      setBusy(null);
    }
  }

  async function unlockSelectedBucket() {
    if (!storage?.unlockBucket || !unlockPassword) return;
    setUnlockBusy(true); setMessage(null);
    try {
      const result = await storage.unlockBucket(unlockPassword);
      if (result && typeof result === "object" && "ok" in result && result.ok === false) throw new Error(t("storage.bucketManager.err.unlock", { defaultValue: "桶密码错误或桶读取失败" }));
      setMessage({ kind: "success", text: t("storage.bucketManager.unlocked", { defaultValue: "桶已解锁，正在恢复运行时。" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.unlock", { defaultValue: "桶密码错误或桶读取失败" }) });
    } finally { setUnlockPassword(""); setUnlockBusy(false); }
  }

  async function selectBucket(bucketId: string) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    if (catalog.selectedBucketId === bucketId) return;
    const entry = catalog.buckets.find((item) => item.bucketId === bucketId);
    if (!entry || !storage?.switchBucket) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.switchUnavailable", { defaultValue: "当前 Coordinator 不支持安全切桶，请刷新页面后重试" }) });
      return;
    }
    let password = window.prompt(t("storage.bucketManager.switchPassword", { defaultValue: `输入“${entry.label}”的桶密码` }));
    if (!password) return;
    setBusy("switch"); setMessage(null);
    try {
      const result = await storage.switchBucket(entry, password);
      reload();
      setReloadRequired(false);
      setMessage({ kind: "success", text: result.vaultUnlocked
        ? t("storage.bucketManager.switchedUnlocked", { defaultValue: `已切换到“${entry.label}”，当前 Key 会话已恢复` })
        : t("storage.bucketManager.switched", { defaultValue: `已切换到“${entry.label}”，请在下方输入桶密码解锁 Key 会话` }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.switch", { defaultValue: "切换桶失败，当前桶未改变" }) });
    } finally {
      password = "";
      setBusy(null);
    }
  }

  async function renameBucket(entry: StorageBucketCatalogEntryV2) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    const label = window.prompt(t("storage.bucketManager.renamePrompt", { defaultValue: "输入新的桶名称" }), entry.label)?.trim();
    if (!label || label === entry.label) return;
    setBusy("rename"); setMessage(null);
    try {
      if (catalog.selectedBucketId === entry.bucketId) {
        if (!storage?.renameBucket) throw new Error("当前桶改名必须通过 Coordinator，请刷新页面后重试");
        await storage.renameBucket(label);
      } else {
        await manager.catalog.updateBucket(entry.bucketId, { label }, entry);
      }
      reload();
      setMessage({ kind: "success", text: t("storage.bucketManager.renamed", { defaultValue: "桶名称已更新" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.rename", { defaultValue: "修改桶名称失败" }) });
    } finally { setBusy(null); }
  }

  async function removeBucket(entry: StorageBucketCatalogEntryV2) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    if (catalog.selectedBucketId === entry.bucketId) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.currentRemove", { defaultValue: "当前桶正在使用，不能直接移除；请先切换到其他桶" }) });
      return;
    }
    if (!window.confirm(t("storage.bucketManager.removeConfirm", { defaultValue: "只移除本机目录中的连接项？桶内数据不会被销毁。" }))) return;
    setBusy("remove"); setMessage(null);
    try {
      await manager.catalog.removeBucket(entry.bucketId, entry);
      reload();
      setMessage({ kind: "success", text: t("storage.bucketManager.removed", { defaultValue: "连接项已移除；桶内数据未删除" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.remove", { defaultValue: "删除桶连接项失败" }) });
    } finally { setBusy(null); }
  }

  async function destroyBucketData(entry: StorageBucketCatalogEntryV2) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    if (catalog.selectedBucketId === entry.bucketId) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.currentDestroy", { defaultValue: "当前桶正在使用，不能销毁数据；请先切换到其他桶" }) });
      return;
    }
    const confirmed = entry.backend === "s3"
      ? window.confirm(t("storage.bucketManager.destroyVisibleConfirm", { label: entry.label, defaultValue: `确认删除“${entry.label}”中当前可见的 S3 对象？历史版本、Delete Marker 和未完成 multipart 可能保留；同时移除本机连接项。` }))
      : window.confirm(t("storage.bucketManager.destroyConfirm", { label: entry.label, defaultValue: `确认销毁“${entry.label}”中的全部本地桶数据？此操作不可恢复，并会同时移除本机连接项。` }));
    if (!confirmed) return;
    let password = "";
    let provider: ReturnType<typeof createBucketProvider> | undefined;
    setBusy("destroy"); setMessage(null);
    try {
      const config = entry.backend === "local"
        ? { kind: "local" as const }
        : await (async () => {
            const entered = window.prompt(t("storage.bucketManager.destroyPassword", { defaultValue: "输入该 S3 桶密码以删除当前可见对象" }));
            if (!entered) throw new Error(t("storage.bucketManager.err.passwordRequired", { defaultValue: "销毁 S3 数据需要桶密码" }));
            password = entered;
            return manager.unlockBucketConfig(entry, password);
          })();
      provider = createBucketProvider(config, entry.bucketId);
      const result = await manager.destroyBucketData({ entry, provider });
      reload();
      setMessage({ kind: "success", text: result.scope === "current-s3-objects"
        ? t("storage.bucketManager.destroyedVisible", { count: result.deletedObjects, defaultValue: `已删除当前可见 S3 对象并移除连接项（${result.deletedObjects} 个）；历史版本等数据可能仍保留。` })
        : t("storage.bucketManager.destroyed", { count: result.deletedObjects, defaultValue: `已销毁本地桶数据并移除连接项（${result.deletedObjects} 个对象）` }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.destroy", { defaultValue: "销毁桶数据失败；未确认的数据不会继续删除" }) });
    } finally {
      password = "";
      provider?.dispose();
      setBusy(null);
    }
  }

  async function exportBucket(entry: StorageBucketCatalogEntryV2) {
    if (!manager || catalogError) {
      setMessage({ kind: "error", text: t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" }) });
      return;
    }
    setBusy("export"); setMessage(null);
    let provider: ReturnType<typeof createBucketProvider> | undefined;
    try {
      let bytes: Uint8Array;
      if (entry.backend === "local") {
        // Local 连接配置不含秘密；冷导出直接读取该桶的已提交快照，
        // 不需要也不应该弹出桶密码。
        provider = createBucketProvider({ kind: "local" }, entry.bucketId);
        bytes = await manager.coldExport(provider);
      } else {
        // S3 的冷导出不能为了构造 Provider 再解密本机配置。只有当前
        // 桶已经在 Coordinator 会话中解锁、且凭据仍在内存时才允许读取；
        // 否则明确提示用户先进入该桶，而不是缓存密码或 Keys。
        if (catalog.selectedBucketId !== entry.bucketId || runtimeStatus !== "ready" || !storage?.coldExportBucket) {
          throw new Error(t("storage.bucketManager.err.exportSession", { defaultValue: "S3 桶需要先解锁并进入当前会话后才能冷导出" }));
        }
        bytes = await storage.coldExportBucket();
      }
      download(`${entry.label.replace(/[^\p{L}\p{N}._-]+/gu, "_")}.keymaster.hold.json`, bytes);
      setMessage({ kind: "success", text: t("storage.bucketManager.exported", { defaultValue: "已导出当前已提交的完整 Hold 配置快照" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.export", { defaultValue: "导出失败，请检查桶连接或当前会话" }) });
    } finally { provider?.dispose(); setBusy(null); }
  }

  function exportLegacyStorageProfile() {
    const envelope = legacyBootstrap?.encryptedStorageProfileEnvelope;
    if (!envelope) return;
    try {
      download("legacy-storage-profile.json", exportStorageProfileEnvelope(envelope));
      setMessage({ kind: "success", text: t("storage.bucketManager.legacyProfileExported", { defaultValue: "旧版 Storage Profile 已导出；原记录仍保留，未自动迁移。" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.legacyExport", { defaultValue: "旧版存储导出失败" }) });
    }
  }

  async function exportLegacyKey(key: KeyRef) {
    if (!vault) return;
    setBusy("export"); setMessage(null);
    try {
      const backup = await vault.exportKeyBackup(key.publicKeyHex);
      download(`${key.label.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "legacy-key"}.keyhold.json`, new TextEncoder().encode(backup));
      setMessage({ kind: "success", text: t("storage.bucketManager.legacyKeyExported", { defaultValue: "旧版 KeyHold 备份已导出；原 OPFS 数据仍保留。" }) });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : t("storage.bucketManager.err.legacyExport", { defaultValue: "旧版存储导出失败" }) });
    } finally {
      setBusy(null);
    }
  }

  function openAddBucket() {
    setDraft(EMPTY_BUCKET_DRAFT);
    setTestedFingerprint(null);
    setMessage(null);
    setEditorOpen(true);
  }

  function closeEditor() {
    if (busy === "test" || busy === "save") return;
    setEditorOpen(false);
    setDraft(EMPTY_BUCKET_DRAFT);
    setTestedFingerprint(null);
  }

  return (
    <main className="storage-bucket-manager" data-testid="storage-bucket-manager">
      <PageHeader
        title={t("storage.bucketManager.title", { defaultValue: "桶管理" })}
        description={t("storage.bucketManager.description", { defaultValue: "按桶查看和切换 Key；连接配置与 Key 数据始终留在各自的桶中。" })}
        actions={<div className="storage-bucket-manager__header-actions"><Button variant="ghost" onClick={() => router.push("/")}>{t("common.action.back", { defaultValue: "返回" })}</Button><input ref={importInputRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importBucketFromFile(event)} /><Button variant="secondary" onClick={() => importInputRef.current?.click()} loading={busy === "import"} disabled={busy !== null}>{t("storage.bucketManager.import", { defaultValue: "导入桶" })}</Button><Button iconLeft={<Plus size={16} />} onClick={openAddBucket} disabled={busy !== null}>{t("storage.bucketManager.newTitle", { defaultValue: "添加桶" })}</Button></div>}
      />

      {message ? <p className={`storage-bucket-manager__message is-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
      {catalogError ? <p className="storage-bucket-manager__message is-error" role="alert">{t("storage.bucketManager.err.catalog", { defaultValue: "本机存储桶目录不可用，请先恢复 localStorage 后重试" })}</p> : null}
      {reloadRequired ? <p className="storage-bucket-manager__reload"><span>{t("storage.bucketManager.reloadHint", { defaultValue: "新桶已成为当前桶；重新加载后会进入新的桶会话。" })}</span><Button variant="secondary" size="sm" onClick={() => window.location.reload()}>{t("storage.bucketManager.reload", { defaultValue: "重新加载" })}</Button></p> : null}

      {legacyBootstrap || legacyError ? <section className="storage-bucket-manager__legacy" aria-labelledby="storage-bucket-legacy-title">
        <div className="storage-bucket-manager__legacy-copy">
          <span className="storage-bucket-manager__eyebrow">LEGACY</span>
          <div><h2 id="storage-bucket-legacy-title">{t("storage.bucketManager.legacyTitle", { defaultValue: "检测到旧版存储" })}</h2>
            <p>{legacyError ?? (legacyBootstrap?.selectedBackend === "opfs"
              ? t("storage.bucketManager.legacyOpfs", { defaultValue: "这是旧版 OPFS 单桶数据。新版不会把它静默映射成 Local，也不会删除原数据。" })
              : t("storage.bucketManager.legacyProfile", { defaultValue: "这是旧版独立 Storage Profile。它与新版桶目录、桶密码模型不同，不能直接当作新版桶。" }))}</p>
          </div>
        </div>
        {legacyBootstrap?.encryptedStorageProfileEnvelope ? <div className="storage-bucket-manager__legacy-action">
          <span>{t("storage.bucketManager.legacyProfileHint", { defaultValue: "先导出加密 Profile 文件，原密码仍只用于旧版解锁；导出不会解密凭据。" })}</span>
          <Button variant="secondary" size="sm" onClick={exportLegacyStorageProfile} disabled={busy !== null}>{t("storage.bucketManager.legacyExportProfile", { defaultValue: "导出旧 Profile" })}</Button>
        </div> : null}
        {legacyBootstrap?.selectedBackend === "opfs" && catalog.buckets.length === 0 ? <div className="storage-bucket-manager__legacy-keys">
          <div><strong>{t("storage.bucketManager.legacyKeysTitle", { defaultValue: "旧版 KeyHold 备份" })}</strong><p>{t("storage.bucketManager.legacyKeysHint", { defaultValue: "逐把导出加密 KeyHold 文件，再在新桶的 Key 管理中逐项导入。不会复制私钥到本机目录。" })}</p></div>
          {legacyKeys.length > 0 ? <ul>{legacyKeys.map((key) => <li key={key.publicKeyHex}><span>{key.label}</span><Button variant="ghost" size="sm" onClick={() => void exportLegacyKey(key)} disabled={busy !== null}>{t("storage.bucketManager.legacyExportKey", { defaultValue: "导出 KeyHold" })}</Button></li>)}</ul> : <p className="storage-bucket-manager__legacy-empty">{t("storage.bucketManager.legacyKeysEmpty", { defaultValue: "暂未读取到旧 Key；请确认旧 OPFS 会话已启动。" })}</p>}
          <Button variant="ghost" size="sm" onClick={() => router.push("/settings/vault")}>{t("storage.bucketManager.openKeyManagement", { defaultValue: "打开 Key 管理" })}</Button>
        </div> : null}
        <p className="storage-bucket-manager__legacy-footnote">{t("storage.bucketManager.legacyMigrationNote", { defaultValue: "迁移是显式、逐步且可回退的：先导出并验证旧文件，再创建新版 Local/S3 桶；在确认新桶可用前，不要清理旧 OPFS 或旧 Profile。" })}</p>
      </section> : null}

      <section className="storage-bucket-manager__section" aria-labelledby="storage-bucket-list-title">
        <div className="storage-bucket-manager__section-heading">
          <div><h2 id="storage-bucket-list-title">{t("storage.bucketManager.listTitle", { defaultValue: "已保存的桶" })}</h2></div>
          <span className="storage-bucket-manager__hint">{catalog.buckets.length} {t("storage.bucketManager.bucketCount", { defaultValue: "个桶" })}</span>
        </div>
        {catalog.buckets.length === 0 ? <p className="storage-bucket-manager__empty">{t("storage.bucketManager.empty", { defaultValue: "还没有存储桶。创建后，连接密文只保存在本机桶目录中。" })}</p> : (
          <ul className="storage-bucket-manager__list">
            {catalog.buckets.map((entry) => {
              const selected = catalog.selectedBucketId === entry.bucketId;
              return <li key={entry.bucketId} className={selected ? "is-selected" : ""}>
                <div className="storage-bucket-manager__bucket-row">
                  <button type="button" className="storage-bucket-manager__bucket" onClick={() => void selectBucket(entry.bucketId)} aria-pressed={selected}>
                    <span className="storage-bucket-manager__bucket-mark">{entry.backend === "local" ? "L" : "S3"}</span>
                    <span><strong>{entry.label}</strong><small>{entry.backend === "local" ? "Local（浏览器本地存储）" : "S3-compatible（加密连接）"}</small></span>
                    {selected ? <em>{t("storage.bucketManager.selected", { defaultValue: "当前桶" })}</em> : null}
                  </button>
                  <div className="storage-bucket-manager__bucket-controls">
                    {!selected ? <Button variant="secondary" size="sm" onClick={() => void selectBucket(entry.bucketId)} disabled={busy !== null}>{t("storage.bucketManager.switch", { defaultValue: "切换" })}</Button> : null}
                    <details className="storage-bucket-manager__more">
                      <summary aria-label={t("storage.bucketManager.more", { defaultValue: "更多桶操作" })}><MoreHorizontal size={18} /></summary>
                      <div className="storage-bucket-manager__more-menu">
                        <button type="button" onClick={() => void exportBucket(entry)} disabled={busy !== null}>{t("storage.bucketManager.export", { defaultValue: "导出桶" })}</button>
                        <button type="button" onClick={() => void changeBucketPassword(entry)} disabled={busy !== null}>{t("storage.bucketManager.changePassword", { defaultValue: "修改密码" })}</button>
                        <button type="button" onClick={() => void editBucket(entry)} disabled={busy !== null}>{t("storage.bucketManager.edit", { defaultValue: "编辑连接配置" })}</button>
                        <button type="button" onClick={() => void renameBucket(entry)} disabled={busy !== null}>{t("storage.bucketManager.rename", { defaultValue: "修改名称" })}</button>
                        <button type="button" onClick={() => void removeBucket(entry)} disabled={busy !== null || selected}>{t("storage.bucketManager.remove", { defaultValue: "移除连接" })}</button>
                        <button type="button" className="is-danger" onClick={() => void destroyBucketData(entry)} disabled={busy !== null || selected}>{entry.backend === "s3" ? t("storage.bucketManager.destroyVisible", { defaultValue: "删除可见对象" }) : t("storage.bucketManager.destroy", { defaultValue: "销毁数据" })}</button>
                      </div>
                    </details>
                  </div>
                </div>
                <div className="storage-bucket-manager__keys" aria-label={`${entry.label} Keys`}>
                  {selected && vaultStatus === "unlocked" ? (keys.length > 0 ? keys.map((key) => {
                    const active = key.publicKeyHex === activePublicKeyHex;
                    return <button key={key.publicKeyHex} type="button" className={active ? "is-active" : ""} onClick={() => active ? undefined : setPendingKey(key)} aria-current={active ? "true" : undefined}><KeyRound size={14} /><span><strong>{key.label || t("storage.bucketManager.unnamedKey", { defaultValue: "未命名 Key" })}</strong><small>{formatShortPublicKey(key.publicKeyHex)}</small></span>{active ? <em><Check size={13} />{t("storage.bucketManager.currentKey", { defaultValue: "当前 Key" })}</em> : <span className="storage-bucket-manager__key-action">{t("storage.bucketManager.switchKey", { defaultValue: "切换" })}</span>}</button>;
                  }) : <p>{t("storage.bucketManager.noKeys", { defaultValue: "该桶暂无 Key" })}</p>) : selected ? <div className="storage-bucket-manager__inline-unlock"><LockKeyhole size={15} /><span>{t("storage.bucketManager.readKeys", { defaultValue: "输入桶密码后读取 Keys" })}</span><input aria-label={t("storage.bucketManager.password", { defaultValue: "桶密码" })} type="password" autoComplete="current-password" value={unlockPassword} onChange={(event) => setUnlockPassword(event.currentTarget.value)} /><Button size="sm" onClick={() => void unlockSelectedBucket()} loading={unlockBusy} disabled={!unlockPassword || unlockBusy || !storage?.unlockBucket}>{t("storage.bucketManager.unlock", { defaultValue: "解锁" })}</Button></div> : <button type="button" className="storage-bucket-manager__locked-keys" onClick={() => void selectBucket(entry.bucketId)}><LockKeyhole size={14} /><span>{t("storage.bucketManager.switchToReadKeys", { defaultValue: "切换到此桶后读取 Keys" })}</span></button>}
                </div>
              </li>;
            })}
          </ul>
        )}
      </section>
      <Modal open={editorOpen} title={draft.editingBucketId ? t("storage.bucketManager.editTitle", { defaultValue: "编辑桶连接配置" }) : t("storage.bucketManager.newTitle", { defaultValue: "添加桶" })} onClose={closeEditor} closeButtonLabel={t("common.action.close", { defaultValue: "关闭" })} footer={<><Button variant="ghost" onClick={closeEditor} disabled={busy === "test" || busy === "save"}>{t("common.action.cancel", { defaultValue: "取消" })}</Button><Button variant="secondary" onClick={() => void testDraft()} loading={busy === "test"} disabled={busy !== null}>{t("storage.bucketManager.test", { defaultValue: "测试连接" })}</Button><Button onClick={() => void saveDraft()} loading={busy === "save"} disabled={busy !== null || testedFingerprint !== bucketDraftFingerprint(draft)}>{draft.editingBucketId ? t("storage.bucketManager.saveEdit", { defaultValue: "保存配置" }) : t("storage.bucketManager.save", { defaultValue: "保存桶" })}</Button></>}>
        <BucketConnectionFields draft={draft} onChange={updateDraft} section="all" lockBackend={Boolean(draft.editingBucketId)} />
        {message ? <p className={`storage-bucket-manager__message is-${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>{message.text}</p> : null}
        <p className="storage-bucket-manager__note">{t("storage.bucketManager.passwordNote", { defaultValue: "密码只在当前测试和保存过程中使用，不会写入目录、日志或长期状态。" })}</p>
      </Modal>
      {vault ? <StorageBucketKeySwitchModal target={pendingKey} vault={vault} catalogBucket={storage?.isCatalogBucket?.() === true} onClose={() => setPendingKey(null)} onActivated={() => { if (pendingKey) setActivePublicKeyHex(pendingKey.publicKeyHex); setPendingKey(null); }} /> : null}
    </main>
  );
}

function StorageBucketKeySwitchModal(props: {
  target: KeyRef | null;
  vault: VaultService;
  catalogBucket: boolean;
  onActivated(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setPassword("");
    setError(undefined);
  }, [props.target?.publicKeyHex]);

  function close() {
    if (busy) return;
    setPassword("");
    setError(undefined);
    props.onClose();
  }

  async function submit() {
    if (!props.target || !password || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await props.vault.activateKey({ publicKeyHex: props.target.publicKeyHex, password });
      if (result.status !== "accepted" && result.status !== "ok") {
        const detail = "message" in result ? result.message : undefined;
        throw new Error(typeof detail === "string" ? detail : t("storage.bucketManager.err.keySwitch", { defaultValue: "切换 Key 失败" }));
      }
      props.onActivated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("storage.bucketManager.err.keySwitch", { defaultValue: "切换 Key 失败" }));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return <Modal
    open={props.target !== null}
    title={t("storage.bucketManager.keySwitchTitle", { defaultValue: "切换 Key" })}
    onClose={close}
    footer={<Button variant="ghost" onClick={close} disabled={busy}>{t("common.action.cancel", { defaultValue: "取消" })}</Button>}
    data-testid="storage-bucket-key-switch-modal"
  >
    {props.target ? <p className="storage-bucket-tree__key-target"><strong>{props.target.label || t("storage.bucketManager.unnamedKey", { defaultValue: "未命名 Key" })}</strong> <code>{formatShortPublicKey(props.target.publicKeyHex)}</code></p> : null}
    <TextInput
      label={props.catalogBucket ? t("storage.bucketManager.bucketPassword", { defaultValue: "桶密码" }) : t("storage.bucketManager.vaultPassword", { defaultValue: "Vault 密码" })}
      type="password"
      autoComplete="current-password"
      value={password}
      onChange={(event) => setPassword(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
      error={error}
      disabled={busy}
      autoFocus
    />
    <Button onClick={() => void submit()} loading={busy} disabled={!password || busy}>{t("storage.bucketManager.keySwitchSubmit", { defaultValue: "使用密码切换" })}</Button>
  </Modal>;
}

/**
 * 顶栏显示“桶 → Keys”的最小树状导航。
 *
 * 目录只含桶元数据；未解锁桶不会尝试读取 Key。切换桶仍交给
 * Coordinator 的原子 switchBucket 流程，失败时不会先改页面目录。
 */
export function StorageBucketManagerEntry() {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const keyspace = useOptionalCapability(KEYSPACE_SERVICE_CAPABILITY);
  const [open, setOpen] = useState(false);
  const [busyBucketId, setBusyBucketId] = useState<string | undefined>();
  const [pendingKey, setPendingKey] = useState<KeyRef | null>(null);
  const [catalog, setCatalog] = useState<StorageCatalogV2>(EMPTY_CATALOG);
  const [catalogError, setCatalogError] = useState<string | undefined>();
  const [keys, setKeys] = useState<Awaited<ReturnType<VaultService["listKeys"]>>>([]);
  const [activePublicKeyHex, setActivePublicKeyHex] = useState<string | undefined>(() => keyspace?.active().activePublicKeyHex ?? vault?.getLifecycleSnapshot().activePublicKeyHex);

  const reload = useCallback(() => {
    try {
      setCatalog(readStorageCatalog());
      setCatalogError(undefined);
    } catch (error) {
      setCatalog(EMPTY_CATALOG);
      setCatalogError(error instanceof Error ? error.message : "Storage catalog is unavailable");
    }
  }, []);

  useEffect(() => {
    reload();
    const onStorage = () => reload();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [reload]);

  useEffect(() => {
    const unsubs = [
      storage?.subscribe(() => { reload(); void loadKeys(); }),
      vault?.onLifecycleChange((snapshot) => {
        setActivePublicKeyHex(snapshot.activePublicKeyHex ?? keyspace?.active().activePublicKeyHex);
        void loadKeys();
      }),
      keyspace?.onActiveKeyChanged((state: ActiveKeyState) => {
        setActivePublicKeyHex(state.activePublicKeyHex);
        void loadKeys();
      })
    ].filter((item): item is () => void => Boolean(item));
    setActivePublicKeyHex(keyspace?.active().activePublicKeyHex ?? vault?.getLifecycleSnapshot().activePublicKeyHex);
    void loadKeys();
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
    // `storage` and `vault` are capability objects; their own subscriptions
    // provide the refresh boundary and should not restart on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyspace, storage, vault, reload]);

  async function loadKeys() {
    if (!vault || vault.status() !== "unlocked") {
      setKeys([]);
      return;
    }
    try { setKeys(await vault.listKeys()); } catch { setKeys([]); }
  }

  const selectedBucketId = storage?.selectedBucketId?.() ?? catalog.selectedBucketId;
  const selectedBucket = catalog.buckets.find((bucket) => bucket.bucketId === selectedBucketId);
  const vaultUnlocked = vault?.status() === "unlocked";

  async function switchBucket(entry: StorageBucketCatalogEntryV2) {
    if (!storage?.switchBucket || entry.bucketId === selectedBucketId) {
      router.push("/storage/buckets");
      setOpen(false);
      return;
    }
    const password = window.prompt(t("storage.bucketManager.switchPasswordPrompt", { label: entry.label, defaultValue: `请输入“${entry.label}”的桶密码` }));
    if (password === null) return;
    setBusyBucketId(entry.bucketId);
    try {
      await storage.switchBucket(entry, password);
      setOpen(false);
      reload();
      await loadKeys();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("storage.bucketManager.err.switch", { defaultValue: "切换桶失败" }));
    } finally {
      setBusyBucketId(undefined);
    }
  }

  function switchKey(key: KeyRef) {
    if (key.publicKeyHex === activePublicKeyHex) {
      setOpen(false);
      return;
    }
    if (!vault || vault.status() !== "unlocked") return;
    setPendingKey(key);
  }

  return <div className="storage-bucket-tree">
    <button
      type="button"
      className="storage-bucket-manager__topbar-entry storage-bucket-tree__trigger"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={t("storage.bucketManager.topbar", { defaultValue: "存储桶" })}
    >
      <HardDrive size={14} aria-hidden="true" />
      <span>{selectedBucket?.label ?? t("storage.bucketManager.topbar", { defaultValue: "存储桶" })}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    {open ? <div className="storage-bucket-tree__panel" role="menu">
      <div className="storage-bucket-tree__heading">
        <span>{t("storage.bucketManager.treeTitle", { defaultValue: "桶 / Keys" })}</span>
        <button type="button" onClick={() => { router.push("/storage/buckets"); setOpen(false); }}>
          {t("storage.bucketManager.manage", { defaultValue: "管理" })}
        </button>
      </div>
      {catalogError ? <p className="storage-bucket-tree__hint is-error">{catalogError}</p> : null}
      {catalog.buckets.length === 0 ? <p className="storage-bucket-tree__hint">{t("storage.bucketManager.empty", { defaultValue: "还没有存储桶" })}</p> : catalog.buckets.map((entry) => {
        const current = entry.bucketId === selectedBucketId;
        return <div key={entry.bucketId} className={`storage-bucket-tree__bucket ${current ? "is-current" : ""}`} role="none">
          <button type="button" role="menuitem" className="storage-bucket-tree__bucket-button" onClick={() => void switchBucket(entry)} disabled={busyBucketId !== undefined}>
            <HardDrive size={14} aria-hidden="true" />
            <span><strong>{entry.label}</strong><small>{entry.backend === "local" ? "localStorage" : "S3-compatible"}</small></span>
            {busyBucketId === entry.bucketId ? <small>{t("common.status.loading", { defaultValue: "处理中…" })}</small> : current ? <small>{t("storage.bucketManager.selected", { defaultValue: "当前" })}</small> : null}
          </button>
          <div className="storage-bucket-tree__keys">
            {current && vaultUnlocked && keys.length > 0 ? keys.map((key) => {
              const active = activePublicKeyHex === key.publicKeyHex;
              return <button key={key.publicKeyHex} type="button" className={active ? "is-active" : undefined} onClick={() => switchKey(key)} aria-current={active ? "true" : undefined}>
                <KeyRound size={12} aria-hidden="true" /><span>{key.label || t("storage.bucketManager.unnamedKey", { defaultValue: "未命名 Key" })}</span>{active ? <><small>{t("storage.bucketManager.currentKey", { defaultValue: "当前" })}</small><Check size={12} aria-hidden="true" /></> : null}
              </button>;
            }) : current && vaultUnlocked ? <span>{t("storage.bucketManager.noKeys", { defaultValue: "暂无 Keys" })}</span> : <button type="button" onClick={() => { if (current) router.push("/storage/buckets"); else void switchBucket(entry); }}><LockKeyhole size={12} aria-hidden="true" /><span>{t("storage.bucketManager.readKeys", { defaultValue: "输入密码读取 Keys" })}</span></button>}
          </div>
        </div>;
      })}
    </div> : null}
    {vault ? <StorageBucketKeySwitchModal
      target={pendingKey}
      vault={vault}
      catalogBucket={storage?.isCatalogBucket?.() === true}
      onClose={() => setPendingKey(null)}
      onActivated={() => {
        if (pendingKey) setActivePublicKeyHex(pendingKey.publicKeyHex);
        setPendingKey(null);
        setOpen(false);
        void loadKeys();
      }}
    /> : null}
  </div>;
}
