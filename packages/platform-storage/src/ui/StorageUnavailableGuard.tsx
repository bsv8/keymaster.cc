// 本地存储不可用时的统一守卫。
//
// 正式介质只有本 Origin 的 IndexedDB，因此「远程不可用」「CORS 失败」
// 「桶未连接」这些状态已经不存在。守卫只处理本地格式与宿主能力的问题：
// 钱包数据损坏、schema 版本过新，或浏览器拒绝打开数据库。
//
// 这些状态都不允许静默创建空钱包覆盖原数据，所以守卫直接呈现明确的
// 恢复提示，而不是把子树降级成「暂无数据」。
import { useState, type ReactNode } from "react";
import { usePluginI18n } from "@keymaster/runtime";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";
import { Button } from "@keymaster/ui";
import type { StorageRpcProxy } from "../coordinator/storageRpcProxy.js";
import { storageErrorCode } from "../runtime/storageError.js";

/** 需要阻断业务界面的本地存储状态。 */
const BLOCKING_STATUSES = new Set(["corrupt", "unsupported", "degraded"]);

export function StorageUnavailableGuard({ service, children }: { service: StorageRpcProxy; children: ReactNode }) {
  const { t } = usePluginI18n();
  const controller = useOptionalPluginCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);

  let status: string | undefined;
  try {
    status = controller?.status();
  } catch {
    status = undefined;
  }

  // 未初始化与锁定都是正常业务状态：由 onboarding / 锁定界面负责解锁，
  // 这里不能把子树藏起来。
  if (status === undefined || !BLOCKING_STATUSES.has(status)) return <>{children}</>;

  if (status === "corrupt") {
    return (
      <StorageGate
        title={t("storage.guard.corrupt.title", { defaultValue: "本地钱包数据无法读取" })}
        message={t("storage.guard.corrupt.body", {
          defaultValue:
            "本机的钱包记录不完整，其他业务已暂停。你可以先尝试导出加密钱包，再选择清理范围。"
        })}
      >
        <CorruptWalletActions service={service} />
      </StorageGate>
    );
  }
  if (status === "unsupported") {
    return (
      <StorageGate
        title={t("storage.guard.unsupported.title", { defaultValue: "本地数据版本过新" })}
        message={t("storage.guard.unsupported.body", {
          defaultValue:
            "本机钱包数据由更新版本的 Keymaster 写入，当前版本无法读取。系统不会退回创建空钱包。"
              + "请升级到最新版后再打开钱包。"
        })}
      />
    );
  }
  return (
    <StorageGate
      title={t("storage.guard.unavailable.title", { defaultValue: "本地存储暂不可用" })}
      message={t("storage.guard.unavailable.body", {
        defaultValue:
          "浏览器暂时无法打开本机数据库（可能是隐私模式、存储配额或数据库版本升级被拒绝）。"
          + "现有数据没有被修改，请关闭其它占用本页的标签后重试。"
      })}
    />
  );
}

function CorruptWalletActions({ service }: { service: StorageRpcProxy }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function clear(recovery: "keep-wallet" | "all") {
    const scope = recovery === "keep-wallet"
      ? "将永久清除本地应用数据、文件、授权和交易恢复记录，保留钱包密钥和网络配置。"
      : "将永久清除本地钱包密钥、网络配置及全部业务数据。没有密钥备份时，可能无法恢复钱包。";
    if (!window.confirm(`${scope}\n此操作无法撤销，是否继续？`)) return;
    setError("");
    setBusy(true);
    try {
      await service.clearCorruptWallet(recovery);
      // 清除成功后，Worker 会通知各页面重新启动钱包。
    } catch (cause) {
      console.error("Wallet recovery clear failed", storageErrorCode(cause));
      setError("清除失败。请重新打开钱包查看当前状态。");
      setBusy(false);
    }
  }

  async function exportWallet() {
    setError("");
    setBusy(true);
    try {
      const { bytes } = await service.exportCorruptWallet();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/json" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "keymaster-recovery-keyhold.json";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      const code = storageErrorCode(cause);
      console.error("Wallet recovery export failed", code);
      setError(code === "storage_not_found" ? "缺少加密密钥文件，无法导出。"
        : code === "storage_wallet_corrupt" || code === "storage_limit_exceeded" ? "加密密钥文件损坏或格式无效，无法导出。"
          : "无法读取加密密钥文件，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div style={{ display: "grid", gap: 8, justifyContent: "center" }}>
      <Button variant="secondary" disabled={busy} onClick={() => void clear("keep-wallet")}>清除应用数据，保留钱包和网络</Button>
      <Button variant="danger" disabled={busy} onClick={() => void clear("all")}>清除全部数据（含钱包）</Button>
      <Button disabled={busy} onClick={() => void exportWallet()}>导出钱包</Button>
    </div>
    {error && <p role="alert">{error}</p>}
  </>;
}

function StorageGate({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        margin: "0 auto",
        maxWidth: 560,
        padding: "48px 24px",
        textAlign: "center",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>{title}</h1>
      <p style={{ opacity: 0.8 }}>{message}</p>
      {children}
    </div>
  );
}
