// packages/plugin-p2pkh/src/pages/P2pkhOverviewPage.tsx
// P2PKH 总览：按 assetId 展示双网络资源与 backfill 状态。
//
// 硬切换 008 收尾：UI 层防御。
// 关键不变量：
//   - keyspace 初始化中或非 single active key 时不调用
//     service.listResources / listBackfillStates / listRecentSyncStates /
//     getAssetBalance，避免触发 "Key storage is not ready" 未处理 Promise。
//   - 所有 Promise 读取需要 catch，失败时显示空态或错误态，不打未处理 Promise。
//   - 组件卸载后不 setState；active key 在请求期间切换时旧请求结果必须丢弃。
//
// 硬切换 003：所有展示文案走 i18n。

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, formatSats, type DataTableColumn } from "@keymaster/ui";
import { useCapability, useI18n, useLocale } from "@keymaster/runtime";
import type { ActiveKeyState, KeyspaceService } from "@keymaster/contracts";
import type {
  P2pkhAssetId,
  P2pkhBackfillState,
  P2pkhKeyResource,
  P2pkhRecentSyncState,
  P2pkhService
} from "../p2pkhContracts.js";
import { P2PKH_ASSETS } from "../p2pkhContracts.js";

function readAssetIdFromLocation(): P2pkhAssetId | undefined {
  const search = window.location.search;
  if (!search) return undefined;
  const params = new URLSearchParams(search);
  const id = params.get("assetId");
  if (id === "bsv" || id === "bsvtest") return id;
  return undefined;
}

type PageReadiness = "initializing" | "no-active-key" | "ready" | "failed";

/**
 * 拉取 token：记录 activeAtRequest + cancelled 标记。
 * 关键不变量：active 在请求期间被切换或组件卸载时，旧 token 标记为
 * cancelled；请求完成时若 cancelled === true 则不写回 state，避免
 * 旧 key 的结果写到新 key 的 UI 上。
 */
interface RequestToken {
  active: ActiveKeyState;
  cancelled: boolean;
}

export function P2pkhOverviewPage() {
  const service = useCapability<P2pkhService>("p2pkh.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const locale = useLocale();
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );
  const [assetId, setAssetId] = useState<P2pkhAssetId | undefined>(() => readAssetIdFromLocation());
  const [rows, setRows] = useState<P2pkhKeyResource[]>([]);
  const [backfills, setBackfills] = useState<P2pkhBackfillState[]>([]);
  const [recentStates, setRecentStates] = useState<P2pkhRecentSyncState[]>([]);
  const [version, setVersion] = useState(0);
  const [readiness, setReadiness] = useState<PageReadiness>(() => computeReadiness(keyspace));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [balanceDisplay, setBalanceDisplay] = useState<{ confirmed: number; unconfirmed: number } | null>(null);
  // 余额加载 token 引用：cancel-and-replace 模式，新请求自动取消旧请求。
  const balanceTokenRef = useRef<RequestToken | null>(null);
  // 资源列表加载 token 引用。
  const listTokenRef = useRef<RequestToken | null>(null);

  // 订阅 keyspace 状态。
  useEffect(() => {
    const offInit = keyspace.onInitializationChange(() => {
      setReadiness(computeReadiness(keyspace));
    });
    const offActive = keyspace.onActiveChange(() => {
      setReadiness(computeReadiness(keyspace));
      // 切 key 时清空数据并重拉 + 取消任何进行中的旧 token。
      setRows([]);
      setBackfills([]);
      setRecentStates([]);
      setBalanceDisplay(null);
      if (listTokenRef.current) listTokenRef.current.cancelled = true;
      listTokenRef.current = null;
      if (balanceTokenRef.current) balanceTokenRef.current.cancelled = true;
      balanceTokenRef.current = null;
      setVersion((v) => v + 1);
    });
    return () => {
      offInit();
      offActive();
    };
  }, [keyspace]);

  // 组件卸载时取消所有进行中的 token。
  useEffect(() => {
    return () => {
      if (listTokenRef.current) listTokenRef.current.cancelled = true;
      listTokenRef.current = null;
      if (balanceTokenRef.current) balanceTokenRef.current.cancelled = true;
      balanceTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    // 未就绪：不调用 service，直接清空展示。
    if (readiness !== "ready") {
      setRows([]);
      setBackfills([]);
      setRecentStates([]);
      return;
    }
    const token: RequestToken = { active: keyspace.active(), cancelled: false };
    if (listTokenRef.current) listTokenRef.current.cancelled = true;
    listTokenRef.current = token;
    let cancelled = false;
    async function load() {
      try {
        const [r, b, s] = await Promise.all([
          service.listResources(assetId),
          service.listBackfillStates(),
          service.listRecentSyncStates()
        ]);
        if (cancelled || token.cancelled) return;
        if (!isSameActive(keyspace.active(), token.active)) return;
        setRows(r);
        setBackfills(b);
        setRecentStates(s);
        setLoadError(null);
      } catch (err) {
        if (cancelled || token.cancelled) return;
        if (!isSameActive(keyspace.active(), token.active)) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setRows([]);
        setBackfills([]);
        setRecentStates([]);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [service, keyspace, readiness, assetId, version]);

  const recentByResource = useMemo(() => {
    const m = new Map<string, P2pkhRecentSyncState>();
    for (const s of recentStates) m.set(s.resourceId, s);
    return m;
  }, [recentStates]);

  const def = assetId ? P2PKH_ASSETS[assetId] : undefined;
  const title = def
    ? t("p2pkh.overview.titleWithAsset", { defaultValue: "P2PKH / {{label}}", label: def.label })
    : t("p2pkh.route.overview", { defaultValue: "P2PKH 总览" });
  const description = def
    ? t("p2pkh.overview.descWithAsset", {
        defaultValue: "BSV {{network}} ({{assetId}}) 资源。",
        network: def.network,
        assetId: def.assetId
      })
    : t("p2pkh.overview.descDefault", { defaultValue: "BSV P2PKH 资源总览。" });

  useEffect(() => {
    if (readiness !== "ready" || !assetId) {
      setBalanceDisplay(null);
      return;
    }
    const token: RequestToken = { active: keyspace.active(), cancelled: false };
    if (balanceTokenRef.current) balanceTokenRef.current.cancelled = true;
    balanceTokenRef.current = token;
    let cancelled = false;
    service
      .getAssetBalance(assetId)
      .then((b) => {
        if (cancelled || token.cancelled) return;
        if (!isSameActive(keyspace.active(), token.active)) return;
        setBalanceDisplay({ confirmed: b.confirmed, unconfirmed: b.unconfirmed });
      })
      .catch((err) => {
        if (cancelled || token.cancelled) return;
        if (!isSameActive(keyspace.active(), token.active)) return;
        setBalanceDisplay(null);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [service, keyspace, readiness, assetId, version]);

  const columns: DataTableColumn<P2pkhKeyResource>[] = useMemo(
    () => [
      { key: "label", header: t("p2pkh.col.label", { defaultValue: "标签" }), render: (r) => r.label },
      { key: "address", header: t("p2pkh.col.address", { defaultValue: "地址" }), render: (r) => <code>{r.address}</code> },
      { key: "network", header: t("p2pkh.col.network", { defaultValue: "网络" }), render: (r) => r.network },
      { key: "keyId", header: t("p2pkh.col.keyId", { defaultValue: "keyId" }), render: (r) => <code>{r.keyId}</code> },
      { key: "resourceId", header: t("p2pkh.col.resourceId", { defaultValue: "resourceId" }), render: (r) => <code>{r.resourceId}</code> },
      {
        key: "sync",
        header: t("p2pkh.col.lastSync", { defaultValue: "最近同步" }),
        render: (r) => {
          const state = recentByResource.get(r.resourceId);
          const ts = state?.lastSuccessAt ?? state?.lastCheckedAt;
          return ts ? dateFmt.format(new Date(ts)) : t("p2pkh.col.neverSynced", { defaultValue: "未同步" });
        }
      }
    ],
    [recentByResource, dateFmt, t]
  );

  let body: React.ReactNode;
  if (readiness === "initializing") {
    body = (
      <EmptyState
        title={t("p2pkh.empty.initializing", { defaultValue: "Key 正在初始化" })}
        description={t("p2pkh.empty.wait", { defaultValue: "请稍候…" })}
      />
    );
  } else if (readiness === "no-active-key") {
    body = (
      <EmptyState
        title={t("p2pkh.empty.noActiveKey", { defaultValue: "请选择一个 active key" })}
        description={t("p2pkh.empty.noActiveKeyDesc", { defaultValue: "在顶栏选择一把 key，或前往 导入 添加。" })}
      />
    );
  } else if (loadError) {
    body = (
      <EmptyState
        title={t("p2pkh.empty.loadFailed", { defaultValue: "加载 P2PKH 资源失败" })}
        description={loadError}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        title={t("p2pkh.empty.noResource", { defaultValue: "还没有 P2PKH 资源" })}
        description={t("p2pkh.empty.noResourceDesc", { defaultValue: "先到 导入 页面导入 WIF/HEX 私钥。" })}
      />
    );
  } else {
    body = <DataTable columns={columns} rows={rows} rowKey={(r) => r.resourceId} />;
  }

  return (
    <div className="p2pkh-overview">
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            <Button variant={assetId === "bsv" ? "primary" : "ghost"} onClick={() => setAssetId("bsv")}>
              {t("p2pkh.asset.bsvMain", { defaultValue: "BSV / main" })}
            </Button>
            <Button variant={assetId === "bsvtest" ? "primary" : "ghost"} onClick={() => setAssetId("bsvtest")}>
              {t("p2pkh.asset.bsvTest", { defaultValue: "BSV / test" })}
            </Button>
            <Button variant="ghost" onClick={() => setAssetId(undefined)}>
              {t("p2pkh.asset.all", { defaultValue: "全部" })}
            </Button>
            <Button
              onClick={() => {
                if (readiness !== "ready") return;
                void service.triggerRecentSync();
                setVersion((v) => v + 1);
              }}
              disabled={readiness !== "ready"}
            >
              {t("p2pkh.action.triggerSync", { defaultValue: "触发同步" })}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (readiness !== "ready") return;
                void service.triggerHistoryBackfill();
                setVersion((v) => v + 1);
              }}
              disabled={readiness !== "ready"}
            >
              {t("p2pkh.action.triggerBackfill", { defaultValue: "触发回填" })}
            </Button>
          </>
        }
      />
      {balanceDisplay ? (
        <p className="p2pkh-overview__balance">
          {t("p2pkh.balance.line", {
            defaultValue: "余额：确认 {{confirmed}} · 未确认 {{unconfirmed}}",
            confirmed: formatSats(balanceDisplay.confirmed),
            unconfirmed: formatSats(balanceDisplay.unconfirmed)
          })}
        </p>
      ) : null}
      {backfills.length > 0 ? (
        <section className="p2pkh-overview__backfills">
          <h4>{t("p2pkh.section.backfill", { defaultValue: "历史回填" })}</h4>
          <ul>
            {backfills.map((b) => (
              <li key={b.resourceId}>
                <code>{b.resourceId}</code>：{b.status} · {b.pagesSynced} {t("p2pkh.unit.pages", { defaultValue: "页" })} / {b.recordsSynced} {t("p2pkh.unit.records", { defaultValue: "条" })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {body}
    </div>
  );
}

function computeReadiness(keyspace: KeyspaceService): PageReadiness {
  if (keyspace.isInitializing()) return "initializing";
  const active = keyspace.active();
  if (active.mode !== "single" || !active.activePublicKeyHash) return "no-active-key";
  return "ready";
}

function isSameActive(a: ActiveKeyState, b: ActiveKeyState): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "single" && b.mode === "single") {
    return a.activePublicKeyHash === b.activePublicKeyHash;
  }
  return true;
}
