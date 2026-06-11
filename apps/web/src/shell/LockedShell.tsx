// apps/web/src/shell/LockedShell.tsx
// 空白/锁定状态界面：
//  - uninitialized（首次启动）：显示两个入口卡片："新建钱包" / "导入私钥"。
//    "新建钱包" 走 vault.createVaultWithInitialKey()：一次创建 Vault + 落首 Key；
//    "导入私钥" 进入首启导入向导（FirstTimeImportWizard），走
//    vault.createVaultWithImportedKey()：先解析导入材料，再一次性建 Vault +
//    落首把导入 Key + 切 active。
//  - locked（已有 vault）：只显示解锁入口 —— 不再提供"已有私钥？导入"按钮。
//    原因：locked 状态下 /import 无法保存私钥，给用户一条不可完成的路径毫无意义。
// 设计缘由：让空白状态首页就承担"选择流程"的责任，而不是一个纯密码表单。
//
// 硬切换 003：所有展示文案走 i18n。表单校验错误信息也走 t()，缺 key 时回退到 fallback。
// password 相关错误信息从原本的"密码至少 8 位"等走 shell.locked.* 资源。
//
// 硬切换 009：首启"新建钱包"必须改走 createVaultWithInitialKey；该高层能力
// 在 Vault 内部事务化（meta + 首 Key + active 切换），失败时统一回滚到
// uninitialized。本页面只负责把"已落库但未自动激活"的可恢复状态以 notice
// 形式带到下一屏，不要展示成"完全失败"。
//
// 硬切换 010：首启"导入私钥"必须改走首启导入向导（FirstTimeImportWizard），
// 该向导走 vault.createVaultWithImportedKey()。**不再**让本页面要求用户先
// 设密码、createVault、再跳 /import——那是会产生"有锁屏密码但 0 key"空 Vault
// 的旧路径，已被本施工单硬切废弃。

import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import {
  KeyPersistedButActivationFailedError,
  type VaultService
} from "@keymaster/contracts";
import { FirstTimeImportWizard } from "./FirstTimeImportWizard.js";

type Mode = "welcome" | "new-wallet-form" | "first-time-import" | "unlock-form";

export function LockedShell() {
  const vault = useCapability<VaultService>("vault.service");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [status, setStatus] = useState(vault.status());
  const [mode, setMode] = useState<Mode>("welcome");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus(vault.status());
    return vault.onStatusChange((s) => {
      setStatus(s);
      // 注意：硬切换 010 之后，首启导入完成后 status 切到 unlocked，
      // App 卸载 LockedShell；不需要在这里主动 push("/import")。
      // 旧实现里 "if (intent === import) push(/import)" 的逻辑已废弃。
    });
  }, [vault]);

  // uninitialized -> 始终显示欢迎页；
  // locked -> 跳到 unlock 模式。
  useEffect(() => {
    if (status === "uninitialized") {
      setMode("welcome");
    } else if (status === "locked") {
      setMode("unlock-form");
    }
  }, [status]);

  function chooseNewWallet() {
    setPassword("");
    setConfirm("");
    setError(null);
    setMode("new-wallet-form");
  }

  function chooseFirstTimeImport() {
    setError(null);
    setMode("first-time-import");
  }

  async function createNewWallet() {
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
      // 硬切换 009：必须走 createVaultWithInitialKey 一次性完成
      // Vault + 首 Key + active 切换。失败由 Vault 内部事务化回滚。
      try {
        await vault.createVaultWithInitialKey({ password });
        // 成功：vault 内部会在 generateKey 成功后才宣布 unlocked，
        // 订阅器会看到 status === "unlocked"，App 切到 UnlockedShell。
      } catch (initErr) {
        if (initErr instanceof KeyPersistedButActivationFailedError) {
          // 可恢复场景：首 Key 已落库，active 没切上。Vault 仍然宣布
          // 了 unlocked（让用户能进入主界面手动切），并把 notice 存到
          // 可查询的 state；AppShell / VaultSettingsPage 会自动展示
          // 横幅。本页面无需再做任何事——status 切换后 LockedShell
          // 会被卸载。
          return;
        }
        // 真失败：Vault 已内部回滚到 uninitialized，给明确错误。
        setError(
          initErr instanceof Error
            ? initErr.message
            : t("shell.locked.createInitialKeyFailed", { defaultValue: "创建钱包失败" })
        );
        return;
      }
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
            onClick={chooseNewWallet}
            data-intent="new"
          >
            <h2>{t("shell.locked.card.newTitle", { defaultValue: "新建钱包" })}</h2>
            <p>{t("shell.locked.card.newBody", { defaultValue: "设置一个本地密码，并立即生成你的第一把 Key。之后可以继续导入其他私钥。" })}</p>
            <span className="locked-shell__card-cta">{t("shell.locked.card.newCta", { defaultValue: "设置密码 →" })}</span>
          </button>
          <button
            type="button"
            className="locked-shell__card"
            onClick={chooseFirstTimeImport}
            data-intent="import"
          >
            <h2>{t("shell.locked.card.importTitle", { defaultValue: "导入私钥" })}</h2>
            <p>{t("shell.locked.card.importBody", { defaultValue: "已经有 WIF / Hex / JSON 文件私钥？先解析导入材料，再设置本机系统锁屏密码一次性创建 Vault。" })}</p>
            <span className="locked-shell__card-cta">{t("shell.locked.card.importCta", { defaultValue: "开始导入 →" })}</span>
          </button>
        </div>
        <EmptyState
          title={t("shell.locked.notice.title", { defaultValue: "私钥不会离开你的浏览器" })}
          description={t("shell.locked.notice.body", { defaultValue: "所有私钥在本地用 WebCrypto AES-GCM 加密，密码不会上传到任何服务器。" })}
        />
      </div>
    );
  }

  // ---------- 新建钱包：设置密码 ----------
  if (mode === "new-wallet-form") {
    return (
      <div className="locked-shell">
        <PageHeader
          title={t("shell.locked.newWallet", { defaultValue: "新建钱包" })}
          description={t("shell.locked.newWalletDesc", {
            defaultValue: "设置一个本地密码。Vault 接下来会生成你的第一把 Key 并自动设为 active。该密码仅保存在本机，用于加密你的私钥。"
          })}
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
          <Button onClick={createNewWallet} loading={busy} disabled={!password || !confirm}>
            {t("shell.locked.create", { defaultValue: "创建" })}
          </Button>
          <Button variant="ghost" onClick={() => setMode("welcome")} disabled={busy}>
            {t("common.action.back", { defaultValue: "返回" })}
          </Button>
        </div>
      </div>
    );
  }

  // ---------- 首启导入：向导 ----------
  if (mode === "first-time-import") {
    return (
      <FirstTimeImportWizard
        onCancel={() => {
          setError(null);
          setMode("welcome");
        }}
      />
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
