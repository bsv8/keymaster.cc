// @keymaster/msfile-media：播放器公共错误。
//
// 错误对象不携带远端响应、媒体字节或原始异常文本。页面只应根据稳定
// code 显示中文提示，详细异常留在本地调试器而不是进入业务状态。

export type MsFileMediaErrorCode =
  | "msfile_media_configuration"
  | "msfile_media_range_invalid"
  | "msfile_media_service_worker"
  | "msfile_media_network"
  | "msfile_media_amount"
  | "msfile_media_integrity"
  | "msfile_media_unsupported_container"
  | "msfile_media_unsupported_codec"
  | "msfile_media_native_unsupported"
  | "msfile_media_browser_capability"
  | "msfile_media_decode_failed"
  | "msfile_media_cancelled";

const DEFAULT_MESSAGES: Record<MsFileMediaErrorCode, string> = {
  msfile_media_configuration: "媒体播放配置无效。",
  msfile_media_range_invalid: "媒体 Range 请求无效。",
  msfile_media_service_worker: "媒体 Service Worker 不可用。",
  msfile_media_network: "媒体数据暂时不可用。",
  msfile_media_amount: "媒体读取金额超过当前限制。",
  msfile_media_integrity: "媒体完整性校验失败。",
  msfile_media_unsupported_container: "浏览器不支持此媒体容器。",
  msfile_media_unsupported_codec: "浏览器不支持此媒体 Codec。",
  msfile_media_native_unsupported: "浏览器原生媒体管线不支持此格式或 Codec。",
  msfile_media_browser_capability: "当前浏览器不具备流式播放能力。",
  msfile_media_decode_failed: "媒体解码失败。",
  msfile_media_cancelled: "媒体播放已取消。",
};

export class MsFileMediaError extends Error {
  readonly name = "MsFileMediaError";

  constructor(
    readonly code: MsFileMediaErrorCode,
    message = DEFAULT_MESSAGES[code],
  ) {
    super(message);
  }
}

export function mediaAbortError(): MsFileMediaError {
  return new MsFileMediaError("msfile_media_cancelled");
}

export function throwIfMediaAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw mediaAbortError();
}

/** 把 service / 浏览器异常收敛为播放器错误，避免错误类型越过包边界。 */
export function normalizeMediaError(error: unknown, signal?: AbortSignal): MsFileMediaError {
  if (signal?.aborted) return mediaAbortError();
  if (error instanceof MsFileMediaError) return error;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    switch (code) {
      case "msfile_media_configuration":
      case "msfile_media_range_invalid":
      case "msfile_media_service_worker":
      case "msfile_media_network":
      case "msfile_media_amount":
      case "msfile_media_integrity":
      case "msfile_media_unsupported_container":
      case "msfile_media_unsupported_codec":
      case "msfile_media_native_unsupported":
      case "msfile_media_browser_capability":
      case "msfile_media_decode_failed":
      case "msfile_media_cancelled":
        return new MsFileMediaError(code);
      case "msfile_price_limit_exceeded":
        return new MsFileMediaError("msfile_media_amount");
      case "msfile_integrity_error":
      case "msfile_invalid_hash":
        return new MsFileMediaError("msfile_media_integrity");
      case "msfile_not_configured":
      case "msfile_supplier_not_found":
      case "msfile_supplier_disabled":
        return new MsFileMediaError("msfile_media_configuration");
      case "msfile_transport_error":
      case "msfile_unavailable":
      case "msfile_content_not_found":
      case "msfile_rate_limited":
      case "msfile_supplier_error":
        return new MsFileMediaError("msfile_media_network");
      default:
        break;
    }
  }
  return new MsFileMediaError("msfile_media_decode_failed");
}
