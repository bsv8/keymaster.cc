// packages/plugin-protocol/src/ProtocolPopupPage.tsx
// 对外协议 popup 页面。
//
// 设计缘由（施工单 001）：
//   - 页面只负责渲染态 + 转交用户操作给 service；密码学 / message 收发
//     / 校验 / 签名 / 加解密一律不进组件。
//   - 页面挂载时 startSession() 一次；之后通过 subscribe 拿到 snapshot
//     驱动渲染。
//   - 解锁页、确认页、执行中、成功、失败态分别对应 service 的 phase。
//   - 不写 localStorage / sessionStorage / IndexedDB / URL hash；用户
//     刷新或关闭 popup 视为会话结束。
//   - 文案中文；错误 message 原样显示英文。
//   - 完成后 `window.close()`。

import { useEffect, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type {
  IdentityGetParams,
  IntentSignParams,
  CipherEncryptParams,
  CipherDecryptParams,
  MethodParams,
  ProtocolMethod,
  ProtocolService,
  ProtocolSessionSnapshot
} from "@keymaster/contracts";
import { PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";

export function ProtocolPopupPage() {
  const service = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [snap, setSnap] = useState<ProtocolSessionSnapshot>(() => service.snapshot());
  const [request, setRequest] = useState<ReturnType<NonNullable<ProtocolService["currentRequest"]>>>(() => service.currentRequest());

  // 挂载时启动会话并订阅；卸载时 endSession。
  useEffect(() => {
    service.startSession();
    const off = service.subscribe((next) => {
      setSnap(next);
      setRequest(service.currentRequest());
    });
    function onMessage(event: MessageEvent) {
      service.handleMessage(event);
    }
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      off();
      service.endSession();
    };
  }, [service]);

  // 状态机分流
  if (snap.phase === "error") {
    return <ErrorView t={t} message={t("protocol.error")} />;
  }
  if (snap.phase === "waiting") {
    return <WaitingView t={t} />;
  }
  if (snap.phase === "unlocking") {
    return <UnlockView t={t} service={service} />;
  }
  if (snap.phase === "executing") {
    return <ExecutingView t={t} />;
  }
  if (snap.phase === "closing") {
    return <DoneView t={t} />;
  }
  // confirming
  if (!request) {
    // 不应到达；显示等待。
    return <WaitingView t={t} />;
  }
  return <ConfirmView t={t} service={service} request={request} />;
}

/* ============== 视图 ============== */

function WaitingView({ t }: { t: (k: string, v?: { defaultValue?: string }) => string }) {
  return (
    <div className="protocol-popup protocol-popup--waiting">
      <PageHeader
        title={t("protocol.waiting.title", { defaultValue: "等待请求" })}
        description={t("protocol.waiting.desc", {
          defaultValue: "第三方站点应当通过 postMessage 发送请求。如果是误打开的，可以直接关闭。"
        })}
      />
    </div>
  );
}

function UnlockView({
  t,
  service
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vault = useCapability<{
    status(): "booting" | "uninitialized" | "locked" | "unlocked";
    onStatusChange(handler: (s: "booting" | "uninitialized" | "locked" | "unlocked") => void): () => void;
    unlock(password: string): Promise<void>;
  }>("vault.service");
  useEffect(() => {
    return vault.onStatusChange((s) => {
      if (s === "unlocked") {
        // 通知 service 继续已绑定 request。
        (service as unknown as { resumeAfterUnlock?: () => void }).resumeAfterUnlock?.();
      }
    });
  }, [vault, service]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("protocol.unlock.err.failed", { defaultValue: "解锁失败" }));
    } finally {
      setBusy(false);
      setPassword("");
    }
  }
  async function cancel() {
    await service.rejectByUser();
    window.close();
  }
  return (
    <div className="protocol-popup protocol-popup--unlock">
      <PageHeader
        title={t("protocol.unlock.title", { defaultValue: "解锁后继续" })}
        description={t("protocol.unlock.desc", {
          defaultValue: "此协议请求需要先解锁本地 Vault。解锁成功后请求会自动继续。"
        })}
      />
      <form onSubmit={submit} className="protocol-popup__form">
        <TextInput
          label={t("protocol.unlock.password", { defaultValue: "密码" })}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          error={error ?? undefined}
        />
        <div className="protocol-popup__actions">
          <Button type="submit" loading={busy} disabled={!password}>
            {t("protocol.unlock.submit", { defaultValue: "解锁" })}
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t("protocol.unlock.cancel", { defaultValue: "取消" })}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ConfirmView({
  t,
  service,
  request
}: {
  t: (k: string, v?: { defaultValue?: string }) => string;
  service: ProtocolService;
  request: { id: string; method: ProtocolMethod; params: MethodParams<ProtocolMethod> };
}) {
  const methodKey = `protocol.confirm.method.${request.method}`;
  const methodLabel = t(methodKey, { defaultValue: request.method });
  const identity = request.method === "identity.get" ? (request.params as IdentityGetParams) : null;
  const sign = request.method === "intent.sign" ? (request.params as IntentSignParams) : null;
  const enc = request.method === "cipher.encrypt" ? (request.params as CipherEncryptParams) : null;
  const dec = request.method === "cipher.decrypt" ? (request.params as CipherDecryptParams) : null;
  const aud = identity?.aud ?? sign?.aud ?? null;
  const text = identity?.text ?? sign?.text ?? enc?.text ?? dec?.text ?? "";
  const claims = identity?.claims ?? [];
  const iat = identity?.iat ?? sign?.iat;
  const exp = identity?.exp ?? sign?.exp;
  const contentType = sign?.contentType ?? enc?.contentType;
  const contentBytes =
    sign?.content?.bytes.byteLength ?? enc?.content?.bytes.byteLength ?? dec?.cipherbytes?.bytes.byteLength ?? 0;
  return (
    <div className="protocol-popup protocol-popup--confirm">
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={methodLabel}
      />
      <dl className="protocol-popup__list">
        {aud ? (
          <>
            <dt>{t("protocol.confirm.origin", { defaultValue: "来源站点" })}</dt>
            <dd>
              <code>{aud}</code>
            </dd>
          </>
        ) : null}
        {text ? (
          <>
            <dt>{t("protocol.confirm.text", { defaultValue: "提示文案" })}</dt>
            <dd>{text}</dd>
          </>
        ) : null}
        {claims.length > 0 ? (
          <>
            <dt>{t("protocol.confirm.claims", { defaultValue: "请求的 claims" })}</dt>
            <dd>
              <ul>
                {claims.map((c) => (
                  <li key={c}><code>{c}</code></li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {contentType ? (
          <>
            <dt>{t("protocol.confirm.contentType", { defaultValue: "内容类型" })}</dt>
            <dd>
              <code>{contentType}</code>（{contentBytes} bytes）
            </dd>
          </>
        ) : null}
        {iat !== undefined && exp !== undefined ? (
          <>
            <dt>{t("protocol.confirm.window", { defaultValue: "有效期" })}</dt>
            <dd>
              <code>
                {iat} → {exp}
              </code>
            </dd>
          </>
        ) : null}
      </dl>
      <div className="protocol-popup__actions">
        <Button onClick={() => service.confirmByUser()}>
          {t("protocol.confirm.confirm", { defaultValue: "确认" })}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            await service.rejectByUser();
            window.close();
          }}
        >
          {t("protocol.confirm.cancel", { defaultValue: "取消" })}
        </Button>
      </div>
    </div>
  );
}

function ExecutingView({ t }: { t: (k: string, v?: { defaultValue?: string }) => string }) {
  return (
    <div className="protocol-popup protocol-popup--executing">
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={t("protocol.executing", { defaultValue: "处理中…" })}
      />
    </div>
  );
}

function DoneView({ t }: { t: (k: string, v?: { defaultValue?: string }) => string }) {
  useEffect(() => {
    // 给调用方一点时间收到 result，再关 popup。
    const timer = window.setTimeout(() => {
      window.close();
    }, 200);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="protocol-popup protocol-popup--done">
      <PageHeader
        title={t("protocol.confirm.title", { defaultValue: "确认请求" })}
        description={t("protocol.done", { defaultValue: "已完成。可以关闭此窗口。" })}
      />
    </div>
  );
}

function ErrorView({ t, message }: { t: (k: string, v?: { defaultValue?: string }) => string; message: string }) {
  return (
    <div className="protocol-popup protocol-popup--error">
      <PageHeader
        title={t("protocol.error", { defaultValue: "请求失败" })}
        description={message}
      />
    </div>
  );
}
