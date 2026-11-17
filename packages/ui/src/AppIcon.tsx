import { useState } from "react";

/** 通用应用图标；相对路径按应用入口解析，加载失败时显示名称首字。 */
export function AppIcon({ icon, url, name, size = 56 }: { icon?: string; url?: string; name: string; size?: number }) {
  const [failed, setFailed] = useState<string>();
  let src: string | undefined;
  try {
    const resolved = new URL(icon ?? "", url);
    if (icon && (["https:", "http:"].includes(resolved.protocol) || resolved.href.startsWith("data:image/"))) src = resolved.href;
  } catch { /* 图标不可用时使用占位。 */ }
  return <span className="app-icon" aria-hidden="true" style={{ width: size, height: size, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: Math.round(size * .25), overflow: "hidden", background: "var(--surface-2)", color: "var(--primary)", fontSize: Math.round(size * .4), fontWeight: 600 }}>
    {src && failed !== src ? <img src={src} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setFailed(src)} /> : Array.from(name)[0]?.toUpperCase() ?? "A"}
  </span>;
}
