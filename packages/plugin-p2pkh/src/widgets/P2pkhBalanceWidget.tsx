// packages/plugin-p2pkh/src/widgets/P2pkhBalanceWidget.tsx
// P2PKH 余额 widget（硬切换 001）：
//   - 金额来源改为 `{ total }`；不再分 confirmed / unconfirmed。
//   - testnet 行受 `includeTestnet` 控制：false 时不展示。
//   - includeTestnet 通过 service.onGlobalSettingsChange 订阅；同 tab 写入
//     由 settings 页调用 service.applyGlobalSettings 主动通知。
//
// 硬切换 008 收尾：UI 层防御，不作为主修复。
// 关键不变量：
//   - keyspace 初始化中（isInitializing === true）不调 service.getAssetBalance，
//     避免触发 "Key storage is not ready" 未处理 Promise。
//   - non-single 模式（无 active）金额显示 "—"，刷新按钮 disabled。
//   - 组件卸载后不 setState；active key 在请求期间切换时旧请求结果必须丢弃。
//   - 不把 readiness 错误转换为 0 余额：未就绪是本地状态，0 余额是链上结果。
//   - refreshAll 与 effect loader 共用同一段"load + activeAtRequest + alive 守卫"逻辑，
//     避免重复实现导致竞态不一致。
//
// 硬切换 003：所有展示文案走 i18n。

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, formatSats } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { ActiveKeyState, KeyspaceService } from "@keymaster/contracts";
import type { P2pkhBalance, P2pkhService } from "../p2pkhContracts.js";

interface BalancesState {
  bsv: P2pkhBalance | null;
  bsvtest: P2pkhBalance | null;
}

type ReadinessState = "initializing" | "no-active-key" | "ready" | "failed";

interface RequestToken {
  active: ActiveKeyState;
  cancelled: boolean;
}

export function P2pkhBalanceWidget() {
  const service = useCapability<P2pkhService>("p2pkh.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  useI18n().language();
  const [balances, setBalances] = useState<BalancesState>({ bsv: null, bsvtest: null });
  const [status, setStatus] = useState(service.syncStatus());
  const [readiness, setReadiness] = useState<ReadinessState>(() => computeReadiness(keyspace));
  const [active, setActive] = useState<ActiveKeyState>(() => keyspace.active());
  const [lastError, setLastError] = useState<string | null>(null);
  const [includeTestnet, setIncludeTestnet] = useState<boolean>(() => service.getGlobalSettings().includeTestnet);
  const tokenRef = useRef<RequestToken | null>(null);

  const loadBalances = useCallback(async (): Promise<RequestToken> => {
    const token: RequestToken = { active: keyspace.active(), cancelled: false };
    if (tokenRef.current) tokenRef.current.cancelled = true;
    tokenRef.current = token;
    if (token.cancelled) return token;
    try {
      const include = service.getGlobalSettings().includeTestnet;
      const calls: Promise<P2pkhBalance>[] = [service.getAssetBalance("bsv")];
      if (include) calls.push(service.getAssetBalance("bsvtest"));
      const results = await Promise.all(calls);
      const bsv = results[0]!;
      const bsvtest = include ? results[1] ?? null : null;
      if (token.cancelled) return token;
      if (!isSameActive(keyspace.active(), token.active)) return token;
      setBalances({ bsv, bsvtest: include ? bsvtest : null });
      setLastError(null);
    } catch (err) {
      if (token.cancelled) return token;
      if (!isSameActive(keyspace.active(), token.active)) return token;
      setLastError(err instanceof Error ? err.message : String(err));
      setBalances({ bsv: null, bsvtest: null });
    }
    return token;
  }, [service, keyspace]);

  useEffect(() => {
    const offInit = keyspace.onInitializationChange((v) => {
      setReadiness(computeReadiness(keyspace, v));
    });
    const offActive = keyspace.onActiveChange((s) => {
      setActive(s);
      setReadiness(computeReadiness(keyspace));
      setBalances({ bsv: null, bsvtest: null });
      if (tokenRef.current) tokenRef.current.cancelled = true;
      tokenRef.current = null;
    });
    return () => {
      offInit();
      offActive();
    };
  }, [keyspace]);

  useEffect(() => service.onSyncStatusChange(setStatus), [service]);

  // 硬切换 001：订阅 service 的 settings 变化；service 内部已统一处理
  // 同 tab 与跨 tab 通知。
  useEffect(() => {
    const off = service.onGlobalSettingsChange((s) => {
      setIncludeTestnet(s.includeTestnet);
    });
    return off;
  }, [service]);

  useEffect(() => {
    if (readiness !== "ready") {
      setBalances({ bsv: null, bsvtest: null });
      if (tokenRef.current) tokenRef.current.cancelled = true;
      tokenRef.current = null;
      return;
    }
    void loadBalances();
  }, [loadBalances, readiness, active, includeTestnet]);

  useEffect(() => {
    return () => {
      if (tokenRef.current) tokenRef.current.cancelled = true;
      tokenRef.current = null;
    };
  }, []);

  const refreshAll = useCallback(async () => {
    if (readiness !== "ready") {
      return;
    }
    try {
      await service.triggerRecentSync();
    } catch {
      // 静默
    }
    await loadBalances();
  }, [readiness, service, loadBalances]);

  const stale = status === "failed" || status === "rate-limited" || lastError !== null;
  const showAmount = (b: P2pkhBalance | null) => (b ? formatSats(b.total) : "—");
  const statusText = computeStatusText(readiness, status, lastError, t);

  return (
    <div className={`home-widget home-widget--p2pkh-balance ${stale ? "is-stale" : ""}`}>
      <header className="home-widget__head">
        <h3>{t("p2pkh.balanceWidget.title", { defaultValue: "P2PKH 余额" })}</h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={refreshAll}
          disabled={readiness !== "ready"}
        >
          {t("p2pkh.balanceWidget.refreshAll", { defaultValue: "刷新全部" })}
        </Button>
      </header>
      <section className="home-widget__row">
        <div>
          <p className="home-widget__label">{t("p2pkh.balanceWidget.bsvMain", { defaultValue: "BSV (main)" })}</p>
          <p className="home-widget__amount">{showAmount(balances.bsv)}</p>
        </div>
      </section>
      {includeTestnet ? (
        <section className="home-widget__row">
          <div>
            <p className="home-widget__label">{t("p2pkh.balanceWidget.bsvTest", { defaultValue: "BSV Testnet (test)" })}</p>
            <p className="home-widget__amount">{showAmount(balances.bsvtest)}</p>
          </div>
        </section>
      ) : null}
      <p className="home-widget__status">
        {t("p2pkh.balanceWidget.statusLabel", { defaultValue: "状态：" })}{statusText}
        {stale ? (
          <span className="home-widget__stale">{t("p2pkh.balanceWidget.staleHint", { defaultValue: " (数据可能陈旧)" })}</span>
        ) : null}
      </p>
    </div>
  );
}

function computeReadiness(
  keyspace: KeyspaceService,
  initializingOverride?: boolean
): ReadinessState {
  const initializing = initializingOverride ?? keyspace.isInitializing();
  if (initializing) return "initializing";
  // 硬切换 005 收尾：active key 模型收窄为"single 模式唯一一把 ready key"；
  // `mode` 字段已删除，readiness 仅以 activePublicKeyHash 是否存在判断。
  if (!keyspace.active().activePublicKeyHash) return "no-active-key";
  return "ready";
}

function isSameActive(a: ActiveKeyState, b: ActiveKeyState): boolean {
  return a.activePublicKeyHash === b.activePublicKeyHash;
}

function computeStatusText(
  readiness: ReadinessState,
  sync: string,
  lastError: string | null,
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string
): string {
  if (readiness === "initializing") return t("p2pkh.balanceWidget.status.initializing", { defaultValue: "Key 正在初始化" });
  if (readiness === "no-active-key") return t("p2pkh.balanceWidget.status.noActiveKey", { defaultValue: "请选择一个 active key" });
  if (readiness === "failed") return t("p2pkh.balanceWidget.status.loadFailed", { defaultValue: "读取失败" });
  if (lastError) {
    return t("p2pkh.balanceWidget.status.withError", { defaultValue: "{{sync}}（{{error}}）", sync: String(sync), error: lastError });
  }
  return sync;
}
