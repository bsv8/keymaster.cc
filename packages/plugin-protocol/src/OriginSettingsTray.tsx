// packages/plugin-protocol/src/OriginSettingsTray.tsx
// popup 顶栏 inline 配置面板：编辑当前 origin 的 p2pkh auto-approve +
// feepool auto-sign + identity / cipher auto-approve 配置。
//
// 设计缘由（施工单 002 硬切换：即时生效 + 样式补全）：
//   - popup 是会话级长存；origin 切换时 settings 跟着重读。
//   - 站点级配置**不**走 settings.registry（settings 路由是 per-user 全局
//     设置；站点级是 per-origin per-popup-session）。
//   - 写操作走 service.setOriginSettings；service 内部同步刷 originCache，
//     让下一次 p2pkh.auto-approve 同步判断立即生效。
//   - 交互模型（施工单 002 硬切换，取代旧的"整页 Save"模式）：
//       * 复选框：点击立即提交（无中间态）；
//       * 数字输入：编辑态本地维护字符串；blur / Enter 才提交；
//       * 提交失败：回滚到上一个已持久化真值，并显示错误；
//       * 不再有"保存"按钮 / "已保存"提示。
//   - 数字字段提交时规范化：空串 / 非整数 / 负数 → 0；合法非负整数保留。
//   - 切换 origin：直接丢弃未提交编辑态，重新读取新 origin 真值。
//   - 简单 busy 门禁：提交过程中禁用所有可写字段，避免快速连击的边缘竞争；
//     **不**引入事务模型、撤销栈、乐观队列、离线缓存。
//   - 样式由 `styles.css` 的 `.origin-settings-panel*` 提供；本文件只管结构。

import { useEffect, useRef, useState } from "react";
import { PageHeader } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import {
  PROTOCOL_SERVICE_CAPABILITY,
  type ProtocolOriginSettingsRecord,
  type ProtocolService
} from "@keymaster/contracts";

interface OriginSettingsTrayInlineProps {
  origin: string;
  onClose: () => void;
}

function defaultOriginSettings(origin: string): ProtocolOriginSettingsRecord {
  return {
    origin,
    p2pkhAutoApproveEnabled: false,
    p2pkhAutoApproveMaxSatoshis: 0,
    identityAutoApproveEnabled: false,
    cipherAutoApproveEnabled: false,
    feePoolAutoSignMaxSatoshis: 0,
    feePoolDefaultFundSatoshis: 0,
    updatedAt: Date.now()
  };
}

/** 数字字段名集合。每个字段单独维护一个本地字符串编辑态。 */
type NumberFieldKey =
  | "p2pkhAutoApproveMaxSatoshis"
  | "feePoolAutoSignMaxSatoshis"
  | "feePoolDefaultFundSatoshis";

type NumberEdits = Partial<Record<NumberFieldKey, string>>;

/**
 * 数字输入规范化（施工单 002 硬切换）：
 *   - 空串 / 非整数 / 负数 → 0；
 *   - 合法非负整数 → 该整数。
 * 返回 `{ display, value }`：display 是回填 input 的字符串，value 是落库数字。
 */
function normalizeNumber(raw: string): { display: string; value: number } {
  const trimmed = raw.trim();
  if (trimmed === "") return { display: "0", value: 0 };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { display: "0", value: 0 };
  }
  return { display: String(n), value: n };
}

export function OriginSettingsTrayInline({ origin, onClose }: OriginSettingsTrayInlineProps) {
  const service = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  useI18n().language();
  /**
   * `record` 是当前已持久化真值。所有"显示真值"与"失败回滚目标"都走它。
   * `null` 表示初始 getOriginSettings 还没回来。
   */
  const [record, setRecord] = useState<ProtocolOriginSettingsRecord | null>(null);
  /**
   * 数字字段的本地字符串编辑态。提交成功且与真值相等时清掉；保留不清理也
   * 无副作用（input 显示 `edits[key] ?? String(record[key])`）。
   */
  const [edits, setEdits] = useState<NumberEdits>({});
  /** 上一次提交失败的错误信息；成功时清空。 */
  const [error, setError] = useState<string | null>(null);
  /**
   * 提交进行中。true 时禁用所有可写字段（简单 busy 门禁，覆盖快速连击与
   * blur/Enter 重复触发的边缘情况）。
   */
  const [saving, setSaving] = useState(false);
  /**
   * origin generation：每次 origin 切换 +1。`commit` 在 await 前后比较
   * 闭包捕获的 gen 与当前 `originGenRef.current`：
   *   - 一致 → 本次 commit 仍属于当前 origin，可以安全更新 state；
   *   - 不一致 → 在途 commit 属于旧 origin，所有回滚 / 错误 / 清理 edits
   *     / setSaving(false) 全部跳过，避免污染新 origin 面板状态。
   *
   * 设计缘由（施工单 002 反馈：origin 切换 in-flight commit 隔离）：
   *   - 旧实现只在 useEffect cleanup 里 `cancelled = true`，但这只阻止了
   *     `getOriginSettings` 的 then 回调用 setRecord；`commit` 内的
   *     `setRecord(prev)` / `setError(...)` / `setSaving(false)` /
   *     `setEdits(...)` 都没经过 cancelled 检查，结果是：用户先在 origin A
   *     点复选框、commit 进入 await，await 期间切到 origin B；旧 commit
   *     失败时会把新 origin 的 record 回滚到 origin A 的 prev，error 也
   *     会显示在新 origin 面板上。
   *   - generation 计数比 cancelled 标志更适合这里的原因：useEffect 清理
   *     回调只能拿到**自己**的 cancelled，无法跨 commit 调用比对；而
   *     originGenRef 是组件级 ref，commit 闭包和 useEffect 共享同一个
   *     计数器。origin 切换 +1，commit 取一次当前值，await 之后再取一
   *     次，差异即"我已不属于当前 origin"。
   */
  const originGenRef = useRef(0);

  // 切换 origin：丢弃旧编辑态 + 旧错误，重新读真值；同时 generation +1，
  // 让所有在途旧 commit 的 post-await 回调失效。
  useEffect(() => {
    const myGen = ++originGenRef.current;
    setRecord(null);
    setEdits({});
    setError(null);
    setSaving(false);
    void service.getOriginSettings(origin).then((rec) => {
      // origin 切换可能在我 await 期间发生；只有 generation 仍匹配才写 state。
      if (myGen !== originGenRef.current) return;
      setRecord(rec ?? defaultOriginSettings(origin));
    });
  }, [origin, service]);

  /**
   * 提交一条已构造好的 next record。失败时回滚到 prev 并显示错误。
   * 设计缘由（施工单 002）：
   *   - 乐观更新：setRecord(next) 先于 await，让 UI 立刻反映新值；
   *   - 失败 → 严格回滚到 prev，且**不**保留失败值（不允许"看起来开了，
   *     实际没开"的假象）；
   *   - 成功 → 清错误；不做"已保存"提示（施工单 002 明确移除）。
   *   - `editedKeys`：调用方告知哪些数字字段刚被提交。提交完成（无论成败）
   *     后清理这些 key 的编辑态，让 input 显示值回退到 record 真值。
   *     复选框路径不传 editedKeys（复选框不走 edits）。
   *   - **origin 隔离**：await 之后比较 generation；不一致说明 origin 已
   *     切走，本 commit 的所有 post-await setState 全部跳过。
   */
  async function commit(
    next: ProtocolOriginSettingsRecord,
    editedKeys?: NumberFieldKey[]
  ): Promise<void> {
    if (!record) return;
    const myGen = originGenRef.current;
    const prev = record;
    setRecord(next);
    setSaving(true);
    setError(null);
    try {
      await service.setOriginSettings(next);
    } catch (err) {
      // origin 已切走 → 旧 commit 的回滚 / error 会污染新 origin 面板，跳过。
      if (myGen === originGenRef.current) {
        setRecord(prev);
        setError(
          err instanceof Error
            ? err.message
            : t("protocol.originSettings.err.saveFailed", { defaultValue: "Failed to save" })
        );
      }
    } finally {
      // 同样门禁：origin 已切走 → 不动新 origin 的 edits / saving。
      // 注：useEffect 已把新 origin 的 edits / saving 重置成干净状态，
      // 这里 setSaving(false) 即使跑也只会 setSaving(false)，无害；同样
      // editedKeys 中的字段也不会出现在新 origin 的 edits 里（已重置），
      // delete 没命中，setEdits 不会触发 re-render。所以这条 finally
      // 防御是兜底，正式路径用 generation gate 跳过。
      if (myGen === originGenRef.current) {
        if (editedKeys && editedKeys.length > 0) {
          setEdits((cur) => {
            let changed = false;
            const out: NumberEdits = { ...cur };
            for (const k of editedKeys) {
              if (k in out) {
                delete out[k];
                changed = true;
              }
            }
            return changed ? out : cur;
          });
        }
        setSaving(false);
      }
    }
  }

  /** 复选框 onChange：构造 next + 立即提交。无中间态。 */
  function toggleBoolean<K extends keyof ProtocolOriginSettingsRecord>(
    key: K,
    value: boolean
  ): void {
    if (!record) return;
    const next: ProtocolOriginSettingsRecord = { ...record, [key]: value };
    void commit(next);
  }

  /**
   * 数字字段提交：规范化 → 幂等检查 → 提交。
   * 幂等：规范化值等于当前 record 真值时不写库（覆盖 blur 与 Enter 连续
   * 触发的边缘情况）。
   */
  function submitNumber(key: NumberFieldKey, display: string): void {
    if (!record) return;
    const { display: normDisplay, value } = normalizeNumber(display);
    // 把规范化后的字符串回写到 edits，让 input 显示 "0" 而不是空串 / NaN。
    setEdits((cur) => ({ ...cur, [key]: normDisplay }));
    if (value === record[key]) return;
    const next: ProtocolOriginSettingsRecord = { ...record, [key]: value };
    void commit(next, [key]);
  }

  if (!record) {
    return (
      <div
        className="origin-settings-panel"
        role="dialog"
        aria-label={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}
      >
        <header className="origin-settings-panel__header">
          <div className="origin-settings-panel__header-text">
            <PageHeader
              title={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}
              description={origin}
            />
          </div>
          <button
            type="button"
            className="origin-settings-panel__close"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </header>
        <div className="origin-settings-panel__loading">…</div>
      </div>
    );
  }

  function renderNumberField(key: NumberFieldKey, label: string) {
    const display = edits[key] ?? String(record![key]);
    return (
      <label className="origin-settings-panel__field">
        <span className="origin-settings-panel__field-label">{label}</span>
        <input
          type="number"
          min={0}
          step={1}
          value={display}
          disabled={saving}
          onChange={(e) => {
            // 闭包捕获：React 事件处理完后 e.currentTarget 会被清空。
            const v = e.currentTarget.value;
            setEdits((cur) => ({ ...cur, [key]: v }));
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value;
            submitNumber(key, v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const v = e.currentTarget.value;
              submitNumber(key, v);
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
        />
      </label>
    );
  }

  return (
    <div
      className="origin-settings-panel"
      role="dialog"
      aria-label={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}
    >
      <header className="origin-settings-panel__header">
        <div className="origin-settings-panel__header-text">
          <PageHeader
            title={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}
            description={origin}
          />
        </div>
        {saving ? (
          <span className="origin-settings-panel__saving">
            {t("protocol.originSettings.saving", { defaultValue: "保存中…" })}
          </span>
        ) : null}
        <button
          type="button"
          className="origin-settings-panel__close"
          onClick={onClose}
          aria-label="close"
        >
          ×
        </button>
      </header>
      <div className="origin-settings-panel__form">
        <label className="origin-settings-panel__field origin-settings-panel__field--inline">
          <input
            type="checkbox"
            checked={record.p2pkhAutoApproveEnabled}
            disabled={saving}
            onChange={(e) => toggleBoolean("p2pkhAutoApproveEnabled", e.currentTarget.checked)}
          />
          <span>
            {t("protocol.originSettings.p2pkhAutoApprove.label", {
              defaultValue: "Auto-approve p2pkh.transfer when amount ≤ max"
            })}
          </span>
        </label>
        {/* ============== 施工单 001：identity / cipher auto-approve ============== */}
        <label className="origin-settings-panel__field origin-settings-panel__field--inline">
          <input
            type="checkbox"
            checked={record.identityAutoApproveEnabled}
            disabled={saving}
            onChange={(e) => toggleBoolean("identityAutoApproveEnabled", e.currentTarget.checked)}
          />
          <span>
            {t("protocol.originSettings.identityAutoApprove.label", {
              defaultValue: "始终同意 账户信息获取"
            })}
          </span>
        </label>
        <label className="origin-settings-panel__field origin-settings-panel__field--inline">
          <input
            type="checkbox"
            checked={record.cipherAutoApproveEnabled}
            disabled={saving}
            onChange={(e) => toggleBoolean("cipherAutoApproveEnabled", e.currentTarget.checked)}
          />
          <span>
            {t("protocol.originSettings.cipherAutoApprove.label", {
              defaultValue: "始终同意 加密解密"
            })}
          </span>
        </label>
        {renderNumberField(
          "p2pkhAutoApproveMaxSatoshis",
          t("protocol.originSettings.p2pkhAutoApproveMax.label", {
            defaultValue: "Max satoshis for auto-approve (0 = off)"
          })
        )}
        {renderNumberField(
          "feePoolAutoSignMaxSatoshis",
          t("protocol.originSettings.feepoolAutoSignMax.label", {
            defaultValue: "Max satoshis for fee-pool auto-sign (0 = off)"
          })
        )}
        {renderNumberField(
          "feePoolDefaultFundSatoshis",
          t("protocol.originSettings.feePoolDefaultFundSatoshis.label", {
            defaultValue: "Fee-pool default initial fund (satoshis). 0 = unconfigured."
          })
        )}
        {error ? (
          <div className="origin-settings-panel__error">
            <code>{error}</code>
          </div>
        ) : null}
      </div>
    </div>
  );
}