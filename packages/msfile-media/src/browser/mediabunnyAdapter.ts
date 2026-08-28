// Mediabunny 适配层：只负责受限探测，不把第三方 Input 直接暴露给插件。
// 运行时使用动态 import，Mediabunny 不进入首页初始 chunk。

import type { InputFormat } from "mediabunny";

export interface MsFileMediabunnyProbe {
  container: "mp3" | "wave" | "mp4" | "webm" | "matroska";
  mimeType: string;
  codecs: readonly string[];
  durationSeconds?: number;
  /** 只有原文件本身已是可 append 的分段格式时才允许直通 MSE。 */
  directMse: boolean;
}

function containerOf(format: InputFormat): MsFileMediabunnyProbe["container"] | undefined {
  if (!format || typeof format.name !== "string" || format.name.length > 64) return undefined;
  switch (format.name.toLowerCase()) {
    case "mp3": return "mp3";
    case "wave": return "wave";
    case "mp4": return "mp4";
    case "webm": return "webm";
    case "matroska": return "matroska";
    default: return undefined;
  }
}

function containsAscii(bytes: Uint8Array, value: string): boolean {
  if (value.length === 0 || bytes.length < value.length) return false;
  for (let offset = 0; offset + value.length <= bytes.length; offset += 1) {
    let match = true;
    for (let index = 0; index < value.length; index += 1) {
      if (bytes[offset + index] !== value.charCodeAt(index)) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

/**
 * 使用 Mediabunny 的 CustomSource 读取 MSFile。探测阶段最多允许触及
 * `maxProbeBlocks` 个未缓存 Block，避免库内部索引扫描变成整文件购买。
 */
// 解析函数和 magic 检查也在 mediaDemux.worker.ts 中运行；本文件只保留
// 类型/纯函数，避免误把 Mediabunny Input 带回 Window 模块。
export { containerOf, containsAscii };
