import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AiRuntime } from "./runtime.js";
import type { Artifact, Json } from "./types.js";

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
const BOOTSTRAP = `(()=>{let port,resolve;const ready=new Promise(r=>resolve=r),pending=new Map();let serial=0;Object.defineProperty(window,'keymasterAI',{value:Object.freeze({ready,async submit(payload){await ready;const id=String(++serial);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('宿主响应超时，请检查会话状态'))},30000);pending.set(id,{resolve,reject,timer});port.postMessage({type:'submit',id,payload})})}})});window.addEventListener('message',function init(e){if(e.source!==parent||e.data?.type!=='keymaster-ai-init'||!e.ports[0]||port)return;port=e.ports[0];port.onmessage=e=>{const p=pending.get(e.data?.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.ok?p.resolve({accepted:true}):p.reject(new Error(e.data.error||'提交失败'))};port.start();resolve();window.removeEventListener('message',init)});})();`;

function documentFor(html: string) {
  // Never pre-parse untrusted markup in a policy-free DOMParser document: even
  // inert HTML parsers may start resource loads. The iframe parser sees our CSP
  // and bridge first. Nested document wrappers are handled by the HTML parser;
  // later meta policies cannot relax an already-applied CSP.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><script>${BOOTSTRAP}</script></head><body>${html}</body></html>`;
}
function feedback(value: unknown): { action: string; values: Record<string, Json> } {
  const encoded = JSON.stringify(value);
  if (!encoded || encoded.length > 64_000) throw new Error("反馈太大（最多 64KB）");
  const parsed = JSON.parse(encoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.action !== "string" || !parsed.action.trim() || parsed.action.length > 200 || !parsed.values || typeof parsed.values !== "object" || Array.isArray(parsed.values)) throw new Error("反馈必须包含 action 字符串和 values 对象");
  return { action: parsed.action, values: parsed.values };
}
export function Sandbox({ artifact, runtime, conversationId, onSubmit, onBack }: { artifact: Artifact; runtime: AiRuntime; conversationId: string; onSubmit(payload: { action: string; values: Record<string, Json> }): Promise<void>; onBack(): void }) {
  useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
  const outlet = useRef<HTMLDivElement>(null);
  const handler = useRef(onSubmit); handler.current = onSubmit;
  const [status, setStatus] = useState("");
  const [accepted, setAccepted] = useState(false);
  const srcDoc = useMemo(() => documentFor(artifact.html), [artifact.html]);
  useEffect(() => {
    // Own the document and its channel in the same effect. StrictMode cleanup
    // must not leave a live iframe holding a closed port and a resolved ready.
    const frame = document.createElement("iframe");
    frame.title = `AI 结果：${artifact.title}`;
    // Without allow-forms Chromium suppresses the submit event itself, so a
    // form's JS handler cannot preventDefault() and call our bridge. CSP's
    // form-action 'none' still blocks native form navigation/submission.
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.referrerPolicy = "no-referrer";
    frame.allow = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'";
    let active = true, initialized = false;
    let channel: MessageChannel | undefined;
    const closeChannel = () => {
      if (!channel) return;
      channel.port1.onmessage = null;
      channel.port1.close(); channel.port2.close();
      channel = undefined;
    };
    const submit = handler.current;
    setStatus(""); setAccepted(false);
    const load = () => {
      if (!active) return;
      // Never grant a new bridge after navigation by the generated document.
      if (initialized) { closeChannel(); setStatus("页面已导航，交互通道关闭；请点击重新展示"); return; }
      initialized = true;
      try {
        const target = frame.contentWindow;
        if (!target) throw new Error("结果页面尚未就绪，请点击重新展示");
        const next = new MessageChannel(); channel = next;
        let busy = false, lastSubmission = 0;
        const seen = new Set<string>();
        next.port1.onmessage = async event => {
          if (!active || channel !== next) return;
          const data = event.data;
          if (!data || data.type !== "submit" || typeof data.id !== "string" || data.id.length > 64) return;
          if (seen.has(data.id)) return;
          if (seen.size >= 1000) { closeChannel(); setStatus("交互次数过多，请点击重新展示"); return; }
          seen.add(data.id);
          let acquired = false;
          try {
            if (busy || Date.now() - lastSubmission < 1000) throw new Error("请等待当前提交完成");
            const payload = feedback(data.payload);
            busy = true; acquired = true; lastSubmission = Date.now(); setAccepted(false); setStatus("正在提交到所属会话…");
            await submit(payload);
            if (!active || channel !== next) return;
            setAccepted(true); setStatus("宿主已接收本次提交。");
            next.port1.postMessage({ id: data.id, ok: true });
          } catch (error) {
            if (!active || channel !== next) return;
            const text = error instanceof Error ? error.message : "提交失败";
            setStatus(`提交失败：${text}`); next.port1.postMessage({ id: data.id, ok: false, error: text });
          } finally { if (acquired) busy = false; }
        };
        next.port1.start();
        target.postMessage({ type: "keymaster-ai-init" }, "*", [next.port2]);
      } catch (error) {
        closeChannel();
        setStatus(`交互通道初始化失败：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    frame.addEventListener("load", load);
    frame.srcdoc = srcDoc;
    outlet.current!.append(frame);
    return () => {
      active = false;
      frame.removeEventListener("load", load);
      closeChannel();
      frame.remove();
    };
  }, [srcDoc, artifact.title, conversationId]);
  return <section className="ai-result">
    <header><strong>AI 生成 · {artifact.title}</strong><span>隔离展示；不要输入密码或私钥</span><button onClick={onBack}>返回所属会话</button></header>
    <p role="status">{runtime.failures.get(conversationId) ? `AI 处理失败：${runtime.failures.get(conversationId)}` : runtime.busy(conversationId) ? "所属会话正在处理；已接收不代表处理完成" : accepted ? "AI 已结束本轮处理；结果请查看所属会话。" : "页面输入在本地处理，明确提交后才发送给 AI 供应商。重新打开会重新执行脚本。"}</p>
    {status && <p role="status">{status}</p>}
    <div className="ai-result-frame" ref={outlet}/>
  </section>;
}
