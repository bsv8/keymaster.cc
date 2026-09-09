/** 将已脱敏诊断复制到剪贴板；Clipboard API 不可用时使用 DOM fallback。 */
export async function copyDiagnosticText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 继续尝试兼容 fallback。
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = typeof document.execCommand === "function" && document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}
