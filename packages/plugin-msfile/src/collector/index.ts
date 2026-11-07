// 采集上报模块：自有导入文件的提交队列、调度与签名编排。
// Worker-safe，页面与 Worker 均可导入类型；服务实例只在 Worker 侧持有。
export {
  COLLECTOR_HEADERS,
  COLLECTOR_SIG_VERSION,
  COLLECTOR_SIGNATURE_DOMAIN,
  COLLECTOR_SUBMISSIONS_PATH,
  COLLECTOR_SUBMISSION_VERSION,
  collectorCanonicalJson,
  collectorDigestInput,
  collectorHex,
  collectorSubmissionUrl,
  collectorBase64Encode,
  collectorBase64Decode,
  type CollectorRecord,
} from "./collectorCodec.js";
export {
  COLLECTOR_EARLY_TRIGGER_COUNT,
  COLLECTOR_HOURLY_MS,
  collectorConfirm,
  collectorSameRecord,
  collectorShouldTrigger,
  collectorUpsert,
  type CollectorConfirmedEntry,
  type CollectorInflight,
} from "./collectorQueue.js";
export { CollectorService, type CollectorServiceDeps, type CollectorSigner } from "./collectorService.js";
export { collectorForOwner, stopCollectorForOwner, type CollectorHostDeps } from "./collectorHost.js";
export { CollectorStore, emptyCollectorDoc, type CollectorDoc, type CollectorPersistedConfig } from "./collectorState.js";
