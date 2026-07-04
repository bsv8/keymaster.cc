// packages/plugin-webrtc/src/WebrtcSettingsPage.tsx
// WebRTC 设置页（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - STUN 配置是**浏览器网络配置**，**不**走 key-scoped storage；
//   - 每条 STUN 服务器一行；新增 / 删除 / blur 自动保存——**无 Save 按钮**；
//   - 提交失败回滚到上一个已落库的真值（与 `OriginSettingsTray` 同样模式）；
//   - "批量测试"按钮只在本地做 ICE gather 自检，**不**宣称任意两端网络
//     一定能建立通话。
//   - **不**支持 TURN：UI 上**不**给 TURN 字段入口；service 测试只发 STUN。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import { PageHeader } from "@keymaster/ui";
import { WEBRTC_SERVICE_CAPABILITY } from "./constants.js";
import {
  validateStunUrl,
  type WebrtcConfig
} from "./webrtcConfig.js";
import type {
  StunDiagnosticResult,
  WebrtcService
} from "./webrtcService.js";

/** STUN URL 字段的本地字符串编辑态。 */
type Edits = Record<number, string>;

/**
 * 设置页根组件：拿不到 service → 降级空态；拿到 → 渲染 Inner。
 */
export function WebrtcSettingsPage(): React.ReactElement {
  const { t } = useI18n();
  const service = useCapabilityOrNull<WebrtcService>(WEBRTC_SERVICE_CAPABILITY);
  if (!service) {
    return (
      <section
        className="km-webrtc-page"
        data-webrtc-settings="missing-service"
      >
        <PageHeader
          title={t("webrtc.page.settings.title", { defaultValue: "WebRTC settings" })}
          description={t("webrtc.page.settings.desc", {
            defaultValue: "webrtc service is not available"
          })}
        />
      </section>
    );
  }
  return <WebrtcSettingsInner service={service} />;
}

function useCapabilityOrNull<T>(key: string): T | null {
  try {
    return useCapability<T>(key);
  } catch {
    return null;
  }
}

interface WebrtcSettingsInnerProps {
  service: WebrtcService;
}

function WebrtcSettingsInner({ service }: WebrtcSettingsInnerProps): React.ReactElement {
  const { t } = useI18n();
  const [saved, setSaved] = useState<WebrtcConfig>(() => ({
    stunServers: [...service.getStunServers()]
  }));
  const [draft, setDraft] = useState<string[]>(() => [...saved.stunServers]);
  /** 行索引 -> 编辑中字符串。命中某行时 input 显示这个；否则显示 draft[i]。 */
  const [edits, setEdits] = useState<Edits>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [diagResults, setDiagResults] = useState<StunDiagnosticResult[] | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  /** config store 变 → 重新拉一次（其它 tab 修改 / 装配层触发 save）。 */
  const genRef = React.useRef(0);

  // 订阅 store：被外部更新时同步到本地 draft。
  // 这里直接在 service 上挂的 subscribe——service 把 store.subscribe 透出。
  useEffect(() => {
    const refresh = () => {
      const next: WebrtcConfig = {
        stunServers: [...service.getStunServers()]
      };
      genRef.current += 1;
      setSaved(next);
      setDraft([...next.stunServers]);
      setEdits({});
      setError(null);
    };
    refresh();
  }, [service]);

  const onChangeRow = useCallback((i: number, v: string) => {
    setEdits((cur) => ({ ...cur, [i]: v }));
  }, []);

  /**
   * 把第 `i` 行提交到 draft。仅在校验通过时落 draft；删除动作（按 X）
   * 直接改 draft。`blur` 行为：先校验这一行；如果失败 → 回滚 edits[i]
   * 到 draft[i]；如果成功 → 写 store。
   */
  const onCommitRow = useCallback(
    async (i: number, display: string) => {
      setError(null);
      const trimmed = display.trim();
      if (trimmed.length === 0) {
        // 视为"删除"
        const nextDraft = draft.filter((_, idx) => idx !== i);
        setDraft(nextDraft);
        setEdits((cur) => {
          const out = { ...cur };
          delete out[i];
          return out;
        });
        await commitConfig(nextDraft);
        return;
      }
      const check = validateStunUrl(trimmed);
      if (!check.ok || check.value === undefined) {
        // 回滚：把这一行恢复成 draft[i]，记错误。
        setEdits((cur) => ({ ...cur, [i]: draft[i] ?? "" }));
        setError(
          t("webrtc.page.settings.invalid", {
            defaultValue: check.error ?? "invalid"
          })
        );
        return;
      }
      const nextDraft = [...draft];
      nextDraft[i] = check.value;
      // 去掉空 / 规范化后重复。
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const u of nextDraft) {
        const trimmedU = u.trim();
        if (trimmedU.length === 0) continue;
        if (!seen.has(trimmedU)) {
          seen.add(trimmedU);
          deduped.push(trimmedU);
        }
      }
      setDraft(deduped);
      setEdits({});
      await commitConfig(deduped);
    },
    [draft, t]
  );

  const commitConfig = useCallback(
    async (nextDraft: string[]) => {
      const myGen = genRef.current;
      const prev = saved;
      setSaving(true);
      setError(null);
      try {
        await service.applyStunServers(nextDraft);
        if (myGen !== genRef.current) return;
        const after = { stunServers: [...service.getStunServers()] };
        setSaved(after);
        setDraft([...after.stunServers]);
      } catch (err) {
        if (myGen !== genRef.current) return;
        setSaved(prev);
        setDraft([...prev.stunServers]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (myGen === genRef.current) setSaving(false);
      }
    },
    [saved, service]
  );

  const onAddRow = useCallback(() => {
    setDraft((cur) => [...cur, ""]);
    // 不立刻写 store——空行留作占位，blur 后再 commit。
  }, []);

  const onRemoveRow = useCallback(
    async (i: number) => {
      const next = draft.filter((_, idx) => idx !== i);
      setDraft(next);
      setEdits((cur) => {
        const out = { ...cur };
        delete out[i];
        return out;
      });
      await commitConfig(next);
    },
    [commitConfig, draft]
  );

  const onRunDiagnostics = useCallback(async () => {
    setDiagRunning(true);
    setDiagResults(null);
    setError(null);
    try {
      // 诊断前先 commit 当前 draft，保证 service 用的是最新 STUN。
      if (draft.length > 0) {
        await commitConfig(draft);
      }
      const res = await service.runStunDiagnostics();
      setDiagResults(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagRunning(false);
    }
  }, [commitConfig, draft, service]);

  // 把当前 store 真值显示回 draft，便于 UI 立刻反映已成功 commit。
  useEffect(() => {
    setDraft([...saved.stunServers]);
  }, [saved.stunServers]);

  const rows = useMemo(() => {
    return draft.map((u, i) => ({
      i,
      value: edits[i] ?? u,
      display: edits[i] ?? u
    }));
  }, [draft, edits]);

  return (
    <section className="km-webrtc-page" data-webrtc-settings="main">
      <PageHeader
        title={t("webrtc.page.settings.title", { defaultValue: "WebRTC settings" })}
        description={t("webrtc.page.settings.desc", {
          defaultValue: "STUN-only config; no TURN."
        })}
      />
      <div>
        <h2 style={{ margin: "0 0 8px 0", fontSize: 16 }}>
          {t("webrtc.page.settings.field.stun.label", { defaultValue: "STUN servers" })}
        </h2>
        <div>
          {rows.map((row) => (
            <div key={`row-${row.i}`} className="km-webrtc-page__stun-row">
              <input
                className="km-webrtc-page__input km-webrtc-page__stun-row__url"
                type="text"
                value={row.display}
                onChange={(e) => onChangeRow(row.i, e.currentTarget.value)}
                onBlur={(e) => {
                  const v = e.currentTarget.value;
                  void onCommitRow(row.i, v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = e.currentTarget.value;
                    void onCommitRow(row.i, v);
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                placeholder={t("webrtc.page.settings.field.stun.placeholder", {
                  defaultValue: "stun:host:port"
                })}
                disabled={saving}
              />
              <button
                type="button"
                className="km-webrtc-page__button"
                onClick={() => void onRemoveRow(row.i)}
                disabled={saving}
                aria-label={t("webrtc.page.settings.field.stun.remove", {
                  defaultValue: "Remove"
                })}
              >
                {t("webrtc.page.settings.field.stun.remove", { defaultValue: "Remove" })}
              </button>
            </div>
          ))}
          <div className="km-webrtc-page__row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="km-webrtc-page__button"
              onClick={onAddRow}
              disabled={saving}
            >
              {t("webrtc.page.settings.field.stun.add", { defaultValue: "Add" })}
            </button>
          </div>
        </div>
      </div>

      {error ? <div className="km-webrtc-page__error">{error}</div> : null}

      <div>
        <button
          type="button"
          className="km-webrtc-page__button km-webrtc-page__button--primary"
          onClick={() => void onRunDiagnostics()}
          disabled={diagRunning}
        >
          {diagRunning
            ? t("webrtc.page.settings.actions.testAll.running", { defaultValue: "Testing…" })
            : t("webrtc.page.settings.actions.testAll", { defaultValue: "Test all STUN" })}
        </button>
        {diagResults ? (
          <div style={{ marginTop: 12 }}>
            <table className="km-webrtc-page__stun-table">
              <tbody>
                {diagResults.map((r) => (
                  <tr key={`diag-${r.url}`}>
                    <td className="km-webrtc-page__stun-row__url">
                      <code>{r.url}</code>
                    </td>
                    <td
                      className={`km-webrtc-page__stun-row__status km-webrtc-page__stun-row__status--${r.status}`}
                    >
                      {t(`webrtc.page.settings.diag.${r.status}`, {
                        defaultValue: r.status
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="km-webrtc-page__hint">
              {t("webrtc.page.settings.diag.note", {
                defaultValue:
                  "this only verifies STUN availability locally"
              })}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
