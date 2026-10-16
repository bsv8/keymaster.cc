import { useEffect, useState } from "react";
import type { MsFileArbitrationTask, MsFileService } from "@keymaster/contracts";

/** 初次打开只读历史进度；所有资金/取回动作都要求点击，不轮询或自动恢复。 */
export function ArbitrationPanel({ service, sessionId, role }: { service: MsFileService; sessionId?: string; role?: "buyer" | "seller" }) {
  const [tasks, setTasks] = useState<MsFileArbitrationTask[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => { try { setTasks(await service.listBitfsArbitrations?.() ?? []); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  useEffect(() => { let active = true; void service.listBitfsArbitrations?.().then(value => { if (active) setTasks(value); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [service]);
  const operate = async (task: MsFileArbitrationTask) => {
    setBusy(true); setError("");
    try { await service.operateBitfsArbitration?.(task.sessionId, task.action); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await refresh(); setBusy(false); }
  };
  const visibleTasks = tasks.filter(task => (!sessionId || task.sessionId === sessionId) && (!role || task.role === role));
  if (sessionId && visibleTasks.length === 0 && !error) return null;
  return <section className={sessionId ? "msfile-purchases__arbitration" : "msfile-settings__section"}>
    <h2>仲裁与文件取回</h2>
    <p>重新登录仅显示进度。请选择下方操作继续；不会自动提交仲裁、广播或取回文件。</p>
    <button disabled={busy} onClick={() => void refresh()}>刷新状态</button>
    {error && <p role="alert">{error}</p>}
    {visibleTasks.length === 0 && <p>暂无待处理的仲裁或文件取回记录。</p>}
    {visibleTasks.map(task => <article key={task.sessionId}>
      <p>{task.role === "seller" ? "卖方" : "买方"} · <code>{task.seedHashHex}</code></p>
      <p>{task.message}</p>
      {task.txid && <p>结算交易：<code>{task.txid}</code></p>}
      <button disabled={busy} onClick={() => void operate(task)}>{task.action === "retrieve" ? "从仲裁取回文件" : task.action === "check" ? "检查结算状态" : "申请仲裁／继续结算"}</button>
    </article>)}
  </section>;
}
