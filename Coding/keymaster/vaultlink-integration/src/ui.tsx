import { useEffect, useState } from "react";
export { HardwareConnectionPanel } from "./hardware-connection-ui.js";
import { Button, Modal, TextInput } from "@keymaster/ui";
import type { WalletPaymentCommand } from "./wallet-payments.js";
export interface PaymentUIProps {
  execute(command: WalletPaymentCommand): Promise<unknown>;
  text(key: string, fallback: string): string;
}
export { PaymentChannelSettings } from "./payment-channel-settings.js";

interface Pending {
  id: string;
  channelId: string;
  owner: string;
  kind: "app" | "plugin";
  amount: string;
  used: string;
  singleLimit: string;
  sessionLimit: string | null;
  reasons: string[];
  recipients: string[];
  fee: string;
  change: string;
  purpose?: "registration" | "signature";
  operation?: string;
  mode?: string;
  facts?: Record<string, string>;
  pool?: { family: string; stage: string; paid: string; locked: string };
}
export function PaymentApprovalDialog({ execute, text }: PaymentUIProps) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [raised, setRaised] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = pending[0];
  useEffect(() => {
    setRaised("");
    setError("");
  }, [request?.id]);
  useEffect(() => {
    let live = true,
      fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await execute({ action: "pending" });
        if (live) setPending(value as Pending[]);
      } catch (e) {
        if (live) {
          setPending([]);
          setError(String(e));
        }
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [execute]);
  async function answer(allow: boolean, increase = false) {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      await execute({
        action: "answer",
        id: request.id,
        allow,
        ...(increase ? { raiseSessionLimit: raised } : {}),
      });
      setPending((p) => p.filter((v) => v.id !== request.id));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!request) return null;
  return (
    <Modal
      open
      title={
        request.purpose
          ? text(
              request.purpose === "registration"
                ? "signing.register"
                : "signing.approve",
              request.purpose === "registration"
                ? "注册签名渠道"
                : "请求签名授权",
            )
          : text("payment.approval", "付款超过免确认额度")
      }
      onClose={() => {
        if (!busy) void answer(false);
      }}
      footer={
        <>
          <Button disabled={busy} onClick={() => void answer(false)}>
            {text("payment.deny", "拒绝")}
          </Button>
          <Button disabled={busy} onClick={() => void answer(true)}>
            {text("payment.once", "仅批准本次")}
          </Button>
          {(request.reasons ?? []).includes("session-limit") ? (
            <Button
              disabled={busy || !raised}
              onClick={() => void answer(true, true)}
            >
              {text("payment.raiseApprove", "提高本会话额度并批准")}
            </Button>
          ) : null}
        </>
      }
    >
      <p>
        {request.owner} · {request.channelId}
      </p>
      {request.purpose ? (
        <div>
          <p>
            {request.operation} · {request.mode}
          </p>
          {Object.entries(request.facts ?? {}).map(([k, v]) => (
            <p key={k} style={{ overflowWrap: "anywhere" }}>
              {k}: {v}
            </p>
          ))}
        </div>
      ) : (
        <>
          <p>
            {text("payment.amount", "支付金额（聪）")}：{request.amount}
          </p>
          <p>
            {text("payment.change", "本 Key 找零（聪）")}：{request.change}
          </p>
          <p>
            {text("payment.fee", "矿工费（聪，不计入渠道额度）")}：{request.fee}
          </p>
          {request.pool ? (
            <div>
              <p>
                {text("payment.pool", "费用池")}：
                {request.pool.family === "connect" ? "Connect" : "BitFS"} ·{" "}
                {request.pool.stage === "fund"
                  ? text("payment.poolFund", "资金存入")
                  : text("payment.poolState", "累计状态交易")}
              </p>
              <p>
                {text("payment.poolPaid", "池内累计对外付款（聪）")}：
                {request.pool.paid}
              </p>
              <p>
                {text("payment.poolLocked", "本次存入池内金额（聪）")}：
                {request.pool.locked}
              </p>
            </div>
          ) : null}
          <p>
            {text("payment.single", "单笔免确认额度（聪）")}：
            {request.singleLimit}
          </p>
          {request.kind === "app" ? (
            <p>
              {text("payment.cumulative", "会话已用／本次后累计／额度")}：
              {request.used} /{" "}
              {String(BigInt(request.used) + BigInt(request.amount))} /{" "}
              {request.sessionLimit}
            </p>
          ) : null}
          <p>
            {request.reasons
              .map((r) =>
                r === "single-limit"
                  ? text("payment.singleExceeded", "超过单笔额度")
                  : r === "session-limit"
                    ? text("payment.sessionExceeded", "超过会话累计额度")
                    : text("payment.disabled", "免确认已关闭"),
              )
              .join("；")}
          </p>
          <p>{text("payment.outputs", "实际交易输出（含找零）")}</p>
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              overflowWrap: "anywhere",
            }}
          >
            {request.recipients.map((r, i) => (
              <p key={i}>{r}</p>
            ))}
          </div>
          {(request.reasons ?? []).includes("session-limit") ? (
            <TextInput
              label={text("payment.raise", "提高当前会话累计额度（聪）")}
              inputMode="numeric"
              value={raised}
              onChange={(e) => setRaised(e.currentTarget.value)}
            />
          ) : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </Modal>
  );
}

export { SignatureHistoryPanel } from "./signature-history-ui.js";
