// packages/platform-storage/src/ui/BucketSetupWizard.tsx
// 桶初始化 / 解锁向导的共享 UI。
//
// 两个宿主共用同一业务状态机（useBucketSetupFlow）：
//   - apps/web 的 InitialSetupPage：`variant="page"`（onboarding 整页）。
//   - 桶管理页：`variant="modal"`（页内 Modal 分步向导）。
// UI 容器与进度展示按 variant 区分，业务步骤、校验与提交完全同源。
//
// 不变量：
//   - 不在页面上回显完整 Endpoint、访问凭据、密码或私钥材料。
//   - 读取失败只允许重试，绝不当作空桶。
//   - 导入步骤复用 @keymaster/plugin-key-import 的 KeyImportWizard。

import { HardDrive, KeyRound, Upload } from "lucide-react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { KeyImportWizard } from "@keymaster/plugin-key-import/KeyImportWizard";
import { StepProgress } from "@keymaster/plugin-key-import/ImportStepProgress";
import { useI18n } from "@keymaster/runtime";
import { BucketConnectionFields } from "./BucketConnectionFields.js";
import { connectionTargetHint, s3ConfigModeLabel } from "./bucketSetupService.js";
import { useBucketSetupFlow } from "./useBucketSetupFlow.js";

export interface BucketSetupWizardProps {
  /** 页面壳（onboarding）或 Modal 壳。 */
  variant?: "page" | "modal";
  /** 提交成功（新建桶 / 解锁已有桶）后的去向。 */
  onDone(): void;
  /** 取消整个向导（Modal 关闭、第一步返回）。 */
  onCancel?(): void;
}

export function BucketSetupWizard({ variant = "page", onDone, onCancel }: BucketSetupWizardProps) {
  const { t } = useI18n();
  const flow = useBucketSetupFlow({ onDone });
  const {
    step, draft, probe, selectedKeyHex, keyDraft, tagName, keyPassword, keyPasswordConfirm,
    startupPassword, startupPasswordConfirm, busy, error, copyState, managerReady,
    connection, mainStepIndex, steps,
  } = flow;
  const isModal = variant === "modal";

  const progress = (
    <StepProgress steps={steps} currentIndex={mainStepIndex} doneUpToIndex={mainStepIndex} />
  );

  let content;
  if (step === "type") {
    content = <>
      <PageHeader title={t("shell.setup.type.title", { defaultValue: "选择桶类型" })} description="选择后填写参数并探测目标：已有钱包进入解锁，空桶进入创建。" />
      <div className="initial-setup__choices">
        <button type="button" onClick={() => flow.chooseBackend("local")}>
          <HardDrive size={22} />
          <span><strong>Local 桶</strong><small>只需填写桶名称；桶 ID 自动生成，不需要启动密码</small></span>
        </button>
        <button type="button" onClick={() => flow.chooseBackend("s3")}>
          <HardDrive size={22} />
          <span><strong>S3-compatible 远端</strong><small>需要启动密码（保护本机保存的连接参数）</small></span>
        </button>
      </div>
      {isModal && onCancel ? (
        <div className="initial-setup__actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{t("common.action.cancel", { defaultValue: "取消" })}</Button>
        </div>
      ) : null}
    </>;
  } else if (step === "parameters") {
    content = <>
      <PageHeader
        title={t("shell.setup.parameters.title", { defaultValue: "填写桶参数" })}
        description={draft.backend === "local"
          ? "填写桶名称（本机显示名称）；桶 ID 由系统随机生成，只需要保证名称不重复。"
          : "填写对象存储位置和访问凭据；点击测试连接并读取桶内 keys/ 目录。"}
      />
      <BucketConnectionFields draft={draft} onChange={flow.updateDraft} section="parameters" />
      {draft.backend === "local" ? (
        <p className="initial-setup__hint">{t("shell.setup.parameters.localIdNote", { defaultValue: "本机桶 ID 会在初始化时随机生成，不需要也不能手工填写。" })}</p>
      ) : null}
      <div className="initial-setup__actions">
        <Button onClick={() => void flow.probeBucket()} loading={busy}>
          {draft.backend === "local" ? "开始创建" : "测试连接并探测"}
        </Button>
        <Button variant="ghost" onClick={() => isModal && onCancel ? onCancel() : flow.setStep("type")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
      <p className="initial-setup__hint">探测只读取 `keys/`，不加锁、不写入；读取失败时只允许重试，不会当作空桶。</p>
    </>;
  } else if (step === "unlock") {
    const keys = probe?.state === "has-keys" ? probe.keys : [];
    content = <>
      <PageHeader
        title="解锁已有钱包"
        description="桶内已有 Key；选择要使用的 Key 并输入它自己的密码。s3 还需要启动密码来保存本机连接记录。"
      />
      <ul className="initial-setup__choices">
        {keys.map((key) => (
          <li key={key.publicKeyHex}>
            <button
              type="button"
              aria-pressed={selectedKeyHex === key.publicKeyHex}
              onClick={() => { flow.setSelectedKeyHex(key.publicKeyHex); }}
            >
              <KeyRound size={22} />
              <span>
                <strong>{key.label || "（无标签）"}</strong>
                <small><code>{key.publicKeyHex.slice(0, 10)}…{key.publicKeyHex.slice(-8)}</code></small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <TextInput
        label="这把 Key 自己的密码"
        type="password"
        value={keyPassword}
        onChange={(event) => flow.setKeyPassword(event.currentTarget.value)}
        autoComplete="current-password"
      />
      {draft.backend === "s3" ? <>
        <TextInput
          label="启动密码（保存本机连接参数）"
          type="password"
          value={startupPassword}
          onChange={(event) => flow.setStartupPassword(event.currentTarget.value)}
          autoComplete="new-password"
        />
        <TextInput
          label="再输入一次启动密码"
          type="password"
          value={startupPasswordConfirm}
          onChange={(event) => flow.setStartupPasswordConfirm(event.currentTarget.value)}
          autoComplete="new-password"
        />
      </> : null}
      <div className="initial-setup__actions">
        <Button
          onClick={() => void flow.submitConnect()}
          loading={busy}
          disabled={!managerReady || selectedKeyHex === undefined || keyPassword.length < 8 || (draft.backend === "s3" && startupPassword.length < 8)}
        >
          解锁并进入钱包
        </Button>
        <Button variant="ghost" onClick={() => flow.setStep("parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "startup-password") {
    content = <>
      <PageHeader title="设置启动密码" description="S3 桶连接参数在本机会用启动密码加密保存；它不用于加密任何 Key。" />
      <TextInput
        label="启动密码（至少 8 位）"
        type="password"
        value={startupPassword}
        onChange={(event) => flow.setStartupPassword(event.currentTarget.value)}
        autoComplete="new-password"
      />
      <TextInput
        label="再输入一次启动密码"
        type="password"
        value={startupPasswordConfirm}
        onChange={(event) => flow.setStartupPasswordConfirm(event.currentTarget.value)}
        autoComplete="new-password"
      />
      <div className="initial-setup__actions">
        <Button onClick={flow.continueStartupPassword} disabled={busy || startupPassword.length < 8 || startupPasswordConfirm.length < 8}>继续</Button>
        <Button variant="ghost" onClick={() => flow.setStep("parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "key-choice") {
    content = <>
      <PageHeader title={t("shell.setup.keyChoice.title", { defaultValue: "设置第一把 Key" })} description="新建或导入；导入会以这把 Key 自己的密码重新加密 KeyHold 文档。" />
      <div className="initial-setup__choices">
        <button type="button" onClick={flow.chooseGeneratedKey}>
          <KeyRound size={22} />
          <span><strong>{t("shell.setup.keyChoice.new", { defaultValue: "新建 Key" })}</strong><small>由受信任的 Coordinator 在提交时生成私钥</small></span>
        </button>
        <button type="button" onClick={() => { flow.setPasswordTarget("import"); flow.setKeyPassword(""); flow.setKeyPasswordConfirm(""); flow.setStep("key-password"); }}>
          <Upload size={22} />
          <span><strong>{t("shell.setup.keyChoice.import", { defaultValue: "导入 Key" })}</strong><small>支持 WIF / Hex / JSON / KeyHold 文件</small></span>
        </button>
      </div>
      <div className="initial-setup__actions">
        <Button variant="ghost" onClick={() => flow.setStep(draft.backend === "s3" ? "startup-password" : "parameters")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "new-key") {
    content = <>
      <PageHeader title={t("shell.setup.newKey.title", { defaultValue: "新建第一把 Key" })} description="填写标签名称；私钥在最终提交边界内生成。" />
      <TextInput
        label={t("shell.setup.newKey.tag", { defaultValue: "Tag Name（Key 标签名称）" })}
        value={tagName}
        onChange={(event) => flow.setTagName(event.currentTarget.value)}
        placeholder={t("shell.setup.newKey.placeholder", { defaultValue: "例如：主 Key" })}
      />
      <div className="initial-setup__actions">
        <Button onClick={flow.continueGeneratedKey} loading={busy} disabled={!tagName.trim()}>继续</Button>
        <Button variant="ghost" onClick={() => flow.setStep("key-choice")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else if (step === "import-key") {
    content = <KeyImportWizard vaultPassword={keyPassword} onCancel={() => flow.setStep("key-choice")} onComplete={flow.acceptImportedKey} />;
  } else if (step === "key-password") {
    content = <>
      <PageHeader title="设置这把 Key 的密码" description="每把 Key 有自己的密码（KeyHold 文档）；与启动密码互不关联。" />
      <TextInput
        label="Key 密码（至少 8 位）"
        type="password"
        value={keyPassword}
        onChange={(event) => flow.setKeyPassword(event.currentTarget.value)}
        autoComplete="new-password"
      />
      <TextInput
        label="再输入一次 Key 密码"
        type="password"
        value={keyPasswordConfirm}
        onChange={(event) => flow.setKeyPasswordConfirm(event.currentTarget.value)}
        autoComplete="new-password"
      />
      <div className="initial-setup__actions">
        <Button onClick={() => flow.continueKeyPassword("create")} disabled={busy || keyPassword.length < 8 || keyPasswordConfirm.length < 8}>继续确认</Button>
        <Button variant="ghost" onClick={() => flow.setStep(flow.passwordTarget === "import" ? "key-choice" : "new-key")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
    </>;
  } else {
    const key = keyDraft;
    const isUnlock = probe?.state === "has-keys";
    content = <>
      <PageHeader
        title={isUnlock ? "确认解锁已有钱包" : t("shell.setup.confirm.title", { defaultValue: "确认并初始化" })}
        description={isUnlock
          ? "确认后只读取 keys/ 并解锁所选 Key；不会创建、覆盖或删除远端对象。"
          : "确认后先抢首 Key 的锁，再写入 keys/<公钥>.keyhold，最后写入本机 device 记录与 session。"}
      />
      <p className="initial-setup__hint">不会显示或复制完整 Endpoint、访问凭据、密码或私钥材料。</p>
      {probe?.state === "has-keys" ? (
        <dl className="initial-setup__summary">
          <dt>操作</dt><dd>解锁已有钱包</dd>
          <dt>桶</dt><dd>{draft.backend === "local" ? "Local" : `S3 / ${s3ConfigModeLabel(draft.s3ConfigMode)}`}</dd>
          {connection?.kind === "s3" ? <><dt>S3 目标摘要</dt><dd>{connectionTargetHint(draft, connection)}</dd></> : null}
          <dt>Key</dt><dd><code>{selectedKeyHex?.slice(0, 10)}…{selectedKeyHex?.slice(-8)}</code></dd>
        </dl>
      ) : (
        <dl className="initial-setup__summary">
          <dt>操作</dt><dd>创建新钱包</dd>
          <dt>桶</dt><dd>{draft.backend === "local" ? `Local / ${draft.label.trim() || "未命名"}` : `S3 / ${s3ConfigModeLabel(draft.s3ConfigMode)}`}</dd>
          {connection?.kind === "s3" ? <><dt>S3 目标摘要</dt><dd>{connectionTargetHint(draft, connection)}</dd></> : null}
          <dt>第一把 Key</dt><dd>{key?.label ?? "未完成"}{key?.kind === "import" ? `（${key.format}）` : "（新建）"}</dd>
        </dl>
      )}
      <div className="initial-setup__actions">
        {isUnlock ? (
          <Button onClick={() => void flow.submitConnect()} loading={busy} disabled={!managerReady || selectedKeyHex === undefined || keyPassword.length < 8 || (draft.backend === "s3" && startupPassword.length < 8)}>
            解锁并进入钱包
          </Button>
        ) : (
          <Button onClick={() => void flow.submitInitialSetup()} loading={busy} disabled={!managerReady || !key}>
            创建桶和第一把 Key
          </Button>
        )}
        <Button variant="ghost" onClick={() => flow.setStep(isUnlock ? "unlock" : "key-password")} disabled={busy}>{t("common.action.back", { defaultValue: "返回" })}</Button>
      </div>
      {busy ? <p role="status">{isUnlock ? "正在解锁并安装运行态，请不要关闭页面。" : "正在写入 KeyHold、本机记录与 session，请不要关闭页面。"}</p> : null}
    </>;
  }

  return (
    <div className={`initial-setup ${isModal ? "initial-setup--modal" : ""}`}>
      {progress}
      {content}
      {error ? (
        <aside className="initial-setup__error" role="alert">
          <h2>{error.title}</h2>
          <p>{error.summary}</p>
          {error.action ? <p>{error.action}</p> : null}
          <p>错误码：<code>{error.code}</code> · 关联 ID：<code>{error.incidentId}</code></p>
          <details>
            <summary>查看脱敏技术诊断</summary>
            <pre>{error.diagnostic}</pre>
            <Button variant="ghost" onClick={() => void flow.copyDiagnostic()}>复制诊断信息</Button>
            {copyState ? <span role="status">{copyState}</span> : null}
          </details>
        </aside>
      ) : null}
    </div>
  );
}
