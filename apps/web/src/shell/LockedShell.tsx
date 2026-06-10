// apps/web/src/shell/LockedShell.tsx
// 空白/锁定状态界面：
//  - uninitialized（首次启动）：显示两个入口卡片："新建钱包" / "导入私钥"。
//    无论选哪个都先要设置 vault 密码（因为保存私钥必须依赖 vault），
//    "导入私钥" 完成后自动跳到 /import 继续流程。
//  - locked（已有 vault）：只显示解锁入口 —— 不再提供"已有私钥？导入"按钮。
//    原因：locked 状态下 /import 无法保存私钥，给用户一条不可完成的路径毫无意义。
// 设计缘由：让空白状态首页就承担"选择流程"的责任，而不是一个纯密码表单。
//
// 硬切换 003：所有展示文案走 i18n。表单校验错误信息也走 t()，缺 key 时回退到 fallback。
// password 相关错误信息从原本的"密码至少 8 位"等走 shell.locked.* 资源。

import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, TextInput } from "@keymaster/ui";
import { router, useCapability, useI18n } from "@keymaster/runtime";
import type { VaultService } from "@keymaster/contracts";

type Mode = "welcome" | "create-form" | "unlock-form";
type PendingIntent = "new" | "import" | null;

// 走 runtime router.push：它会本地通知 pathname 订阅者，Sidebar /
// Breadcrumbs 才能感知到路由变化。这里自己 pushState 会被吞掉。
const push = router.push;

export function LockedShell() {
  const vault = useCapability<VaultService>("vault.service");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [status, setStatus] = useState(vault.status());
  const [mode, setMode] = useState<Mode>("welcome");
  const [pending, setPending] = useState<PendingIntent>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus(vault.status());
    return vault.onStatusChange((s) => {
      setStatus(s);
      if (s === "unlocked") {
        // 刚解锁：之前如果是 import 意图，跳到导入页。
        const intent = pendingRef.current;
        if (intent === "import") push("/import");
        setPending(null);
      }
    });
  }, [vault]);

  // pending 用 ref 形式读最新值，避免 useEffect 闭包陷阱。
  const pendingRef = { current: pending };
  pendingRef.current = pending;

  // uninitialized -> 始终显示欢迎页；
  // locked -> 跳到 unlock 模式。
  useEffect(() => {
    if (status === "uninitialized") {
      setMode("welcome");
    } else if (status === "locked") {
      setMode("unlock-form");
    }
  }, [status]);

  function choose(intent: "new" | "import") {
    setPending(intent);
    setPassword("");
    setConfirm("");
    setError(null);
    setMode("create-form");
  }

  async function create() {
    setError(null);
    if (password.length < 8) {
      setError(t("shell.locked.passwordTooShort", { defaultValue: "密码至少 8 位" }));
      return;
    }
    if (password !== confirm) {
      setError(t("shell.locked.passwordMismatch", { defaultValue: "两次密码不一致" }));
      return;
    }
    setBusy(true);
    try {
      await vault.createVault(password);
      // createVault 内部会切到 unlocked，订阅器会处理跳转。
    } catch (err) {
      setError(err instanceof Error ? err.message : t("shell.locked.createFailed", { defaultValue: "创建失败" }));
    } finally {
      setBusy(false);
      setPassword("");
      setConfirm("");
    }
  }

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      await vault.unlock(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("shell.locked.unlockFailed", { defaultValue: "解锁失败" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  // ---------- 空白系统：欢迎页 ----------
  if (mode === "welcome") {
    return (
      <div className="locked-shell locked-shell--welcome">
        <header className="locked-shell__hero">
          <h1>Keymaster</h1>
          <p>{t("shell.locked.welcome.subtitle", { defaultValue: "欢迎。选择你要开始的流程：" })}</p>
        </header>
        <div className="locked-shell__cards">
          <button
            type="button"
            className="locked-shell__card"
            onClick={() => choose("new")}
            data-intent="new"
          >
            <h2>{t("shell.locked.card.newTitle", { defaultValue: "新建钱包" })}</h2>
            <p>{t("shell.locked.card.newBody", { defaultValue: "设置一个本地密码，创建一个空的 BSV 钱包。之后可以再导入私钥。" })}</p>
            <span className="locked-shell__card-cta">{t("shell.locked.card.newCta", { defaultValue: "设置密码 →" })}</span>
          </button>
          <button
            type="button"
            className="locked-shell__card"
            onClick={() => choose("import")}
            data-intent="import"
          >
            <h2>{t("shell.locked.card.importTitle", { defaultValue: "导入私钥" })}</h2>
            <p>{t("shell.locked.card.importBody", { defaultValue: "已经有 WIF / Hex / JSON 文件私钥？先设置密码保存 vault，再选择格式导入。" })}</p>
            <span className="locked-shell__card-cta">{t("shell.locked.card.importCta", { defaultValue: "设置密码并导入 →" })}</span>
          </button>
        </div>
        <EmptyState
          title={t("shell.locked.notice.title", { defaultValue: "私钥不会离开你的浏览器" })}
          description={t("shell.locked.notice.body", { defaultValue: "所有私钥在本地用 WebCrypto AES-GCM 加密，密码不会上传到任何服务器。" })}
        />
      </div>
    );
  }

  // ---------- 创建 vault 密码（welcome 之后） ----------
  if (mode === "create-form") {
    return (
      <div className="locked-shell">
        <PageHeader
          title={pending === "import" ? t("shell.locked.createForImport", { defaultValue: "创建密码后导入私钥" }) : t("shell.locked.newWallet", { defaultValue: "新建钱包" })}
          description={
            pending === "import"
              ? t("shell.locked.createForImportDesc", { defaultValue: "导入私钥需要先创建一个本地 vault 来保存它。" })
              : t("shell.locked.newWalletDesc", { defaultValue: "设置一个本地密码。该密码仅保存在本机，用于加密你的私钥。" })
          }
        />
        <TextInput
          label={t("shell.locked.passwordNew", { defaultValue: "新密码" })}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
        />
        <TextInput
          label={t("shell.locked.passwordConfirm", { defaultValue: "确认密码" })}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.currentTarget.value)}
          error={error ?? undefined}
        />
        <div className="locked-shell__actions">
          <Button onClick={create} loading={busy} disabled={!password || !confirm}>
            {pending === "import" ? t("shell.locked.createContinueImport", { defaultValue: "创建并继续导入" }) : t("shell.locked.create", { defaultValue: "创建" })}
          </Button>
          <Button variant="ghost" onClick={() => setMode("welcome")} disabled={busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- 已有 vault：解锁 ----------
  return (
    <div className="locked-shell">
      <PageHeader
        title={t("shell.locked.lockedTitle", { defaultValue: "钱包已锁定" })}
        description={t("shell.locked.lockedDesc", { defaultValue: "需要先解锁本地 Vault，解锁后可以导入或管理私钥。" })}
      />
      <TextInput
        label={t("shell.locked.password", { defaultValue: "密码" })}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        error={error ?? undefined}
      />
      <div className="locked-shell__actions">
        <Button onClick={unlock} loading={busy} disabled={!password}>
          {t("common.action.unlock", { defaultValue: "解锁" })}
        </Button>
      </div>
    </div>
  );
}
