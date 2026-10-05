// 本地存储不可用时的统一守卫。
//
// 正式介质只有本 Origin 的 IndexedDB，因此「远程不可用」「CORS 失败」
// 「桶未连接」这些状态已经不存在。守卫只处理本地格式与宿主能力的问题：
// 钱包数据损坏、schema 版本过新，或浏览器拒绝打开数据库。
//
// 这些状态都不允许静默创建空钱包覆盖原数据，所以守卫直接呈现明确的
// 恢复提示，而不是把子树降级成「暂无数据」。
import type { ReactNode } from "react";
import { usePluginI18n } from "@keymaster/runtime";
import { useOptionalPluginCapability } from "webloom-framework/react";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";

/** 需要阻断业务界面的本地存储状态。 */
const BLOCKING_STATUSES = new Set(["corrupt", "unsupported", "degraded"]);

export function StorageUnavailableGuard({ children }: { children: ReactNode }) {
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
            "本机保存的钱包元数据或 Key 文件不完整。为避免覆盖现有数据，系统不会自动创建新钱包。"
              + "如果此前导出了加密 KeyHold 文件，可以在确认不需要本机数据后重置钱包，再从该文件恢复。"
        })}
      />
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

function StorageGate({ title, message }: { title: string; message: string }) {
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
    </div>
  );
}
