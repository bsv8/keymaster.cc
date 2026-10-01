// apps/web/src/shell/LockedShell.tsx
// 未初始化 / 锁定状态界面（单 Key 本地存储，docs/存储.md）。
//
// 只有两种模式，共用 OnboardingShell：
//   - `uninitialized`：只有两条路径 —— 新建钱包 Key，或导入钱包 Key。
//     两者都走同一个原子入口 `vault.initialize(plan)`；没有存储类型选择、
//     没有桶配置、没有"连接已有远程空间"。
//   - `locked`：只解锁。已有 Key 时创建/导入入口必须不可用——要更换身份
//     只能先重置钱包，因此本页不提供第二条路径。
//
// 关于错误处理：初始化要么整体落盘、要么什么都没写。因此这里没有
// "Key 已保存但未激活"这类可恢复中间态；失败直接回到当前模式并给出
 // 可行动错误。
//
// 所有展示文案走 i18n，缺 key 时回退到 defaultValue。

import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useResourceSelector } from "webloom-framework/react";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import { VAULT_SERVICE_CAPABILITY, type VaultService } from "@keymaster/contracts";
import { KeyImportWizard } from "@keymaster/plugin-key-import/KeyImportWizard";
import { OnboardingShell } from "./OnboardingShell.js";

type Mode = "welcome" | "new-wallet-form" | "first-time-import" | "unlock-form";

export function LockedShell() {
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const status = useResourceSelector<ReturnType<VaultService["status"]>, ReturnType<VaultService["status"]>>(
    host.resourceStore,
    "shell.vault-status",
    [],
    (s) => s.data ?? "uninitialized"
  );
  const [mode, setMode] = useState<Mode>("welcome");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockedKeyLabel, setLockedKeyLabel] = useState<string | undefined>(undefined);

  // 锁定态只需要知道"这把 Key 叫什么"，好让用户确认自己解锁的是哪个身份。
  // 读取失败不阻断解锁：冷启动路径本身不依赖这个标签。
  useEffect(() => {
    if (status !== "locked") {
      setLockedKeyLabel(undefined);
      return;
    }
    let cancelled = false;
    void vault.getCurrentKey()
      .then((key) => {
        if (!cancelled) setLockedKeyLabel(key?.label);
      })
      .catch(() => {
        if (!cancelled) setLockedKeyLabel(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [status, vault]);

  // uninitialized -> 欢迎页（可选两条路径）；locked -> 解锁表单。
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

  function backToWelcome() {
    setPassword("");
    setConfirm("");
    setError(null);
    setMode("welcome");
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
      // 一次性原子提交：`key.json` + `.keymaster/meta` + 必要初始系统数据
      // 在同一个 IndexedDB 事务里完成。只有事务结束才报告成功。
      await vault.initialize({
        transactionId: `create-${Date.now()}`,
        firstKey: {
          kind: "generate",
          label: t("shell.locked.defaultKeyLabel", { defaultValue: "我的钱包" }),
          capabilities: ["p2pkh"],
          password
        }
      });
      // 成功：Coordinator 已装好运行绑定，App 切到 UnlockedShell。
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("shell.locked.createInitialKeyFailed", { defaultValue: "创建钱包失败" })
      );
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
      const result = await vault.unlock(password);
      if (result.status !== "accepted" && result.status !== "already-unlocked") {
        setError(
          "message" in result
            ? result.message
            : result.status === "blocked"
              ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
              : `Unlock failed: ${result.status}`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("shell.locked.unlockFailed", { defaultValue: "解锁失败" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  // ---------- 未初始化：欢迎页 ----------
  if (mode === "welcome") {
    return (
      <OnboardingShell width="wide">
        <div className="locked-shell locked-shell--welcome">
          <header className="locked-shell__hero">
            <h1>{t("shell.locked.welcome.title", { defaultValue: "欢迎使用 Keymaster" })}</h1>
            <p>{t("shell.locked.welcome.subtitle", { defaultValue: "欢迎。选择你要开始的流程：" })}</p>
          </header>
          <div className="locked-shell__cards">
            <button type="button" className="locked-shell__card" onClick={chooseNewWallet} data-intent="new">
              <h2>{t("shell.locked.card.newTitle", { defaultValue: "新建钱包" })}</h2>
              <p>
                {t("shell.locked.card.newBody", {
                  defaultValue: "设置一个 Key 密码，生成你的钱包 Key。数据只保存在本机浏览器的 IndexedDB。"
                })}
              </p>
              <span className="locked-shell__card-cta">
                {t("shell.locked.card.newCta", { defaultValue: "设置密码 →" })}
              </span>
            </button>
            <button type="button" className="locked-shell__card" onClick={chooseFirstTimeImport} data-intent="import">
              <h2>{t("shell.locked.card.importTitle", { defaultValue: "导入钱包 Key" })}</h2>
              <p>
                {t("shell.locked.card.importBody", {
                  defaultValue: "已经有 WIF / Hex / 加密 KeyHold 文件？解析并设置 Key 密码，一次性提交为钱包的唯一 Key。"
                })}
              </p>
              <span className="locked-shell__card-cta">
                {t("shell.locked.card.importCta", { defaultValue: "开始导入 →" })}
              </span>
            </button>
          </div>
          <EmptyState
            title={t("shell.locked.notice.title", { defaultValue: "私钥不会离开你的浏览器" })}
            description={t("shell.locked.notice.body", {
              defaultValue: "钱包 Key 以加密形式保存在本机 IndexedDB；Key 密码不会上传到任何服务器。清除浏览器数据会一并删除钱包。"
            })}
          />
        </div>
      </OnboardingShell>
    );
  }

  // ---------- 新建钱包：设置 Key 密码 ----------
  if (mode === "new-wallet-form") {
    return (
      <OnboardingShell width="narrow">
        <div className="locked-shell locked-shell--form">
          <PageHeader
            title={t("shell.locked.newWallet", { defaultValue: "新建钱包" })}
            description={t("shell.locked.newWalletDesc", {
              defaultValue:
                "设置一个 Key 密码。钱包 Key 会和初始化标记在同一个 IndexedDB 事务里写入；提交失败不会留下半成品。"
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
            <Button variant="ghost" onClick={backToWelcome} disabled={busy}>
              {t("common.action.back", { defaultValue: "返回" })}
            </Button>
          </div>
        </div>
      </OnboardingShell>
    );
  }

  // ---------- 首次导入：向导 ----------
  if (mode === "first-time-import") {
    return (
      <OnboardingShell width="wizard">
        <div className="locked-shell locked-shell--wizard">
          <KeyImportWizard onCancel={backToWelcome} />
        </div>
      </OnboardingShell>
    );
  }

  // ---------- 已有钱包：解锁 ----------
  return (
    <OnboardingShell width="narrow">
      <div className="locked-shell locked-shell--form">
        <PageHeader
          title={t("shell.locked.lockedTitle", { defaultValue: "钱包已锁定" })}
          description={t("shell.locked.lockedDesc", {
            defaultValue: "输入 Key 密码解锁本机钱包。更换身份需要先重置钱包。"
          })}
        />
        {lockedKeyLabel ? (
          <p className="locked-shell__locked-key">
            {lockedKeyLabel}
          </p>
        ) : null}
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
    </OnboardingShell>
  );
}
