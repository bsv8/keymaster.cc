// Keymaster 运行时能力标识。
//
// MessageBus 的契约与实现属于 WebLoom；这里仅保留 Keymaster 为兼容现有
// 插件清单而定义的 capability key。它不是 WebLoom 公共 API 的再导出。

/** Keymaster 兼容的 MessageBus capability key。 */
export const RUNTIME_MESSAGE_BUS = "runtime.messageBus";
