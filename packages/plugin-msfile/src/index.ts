// packages/plugin-msfile/src/index.ts
// 页面侧公共出口。Worker 侧请使用 `@keymaster/plugin-msfile/coordinator`。

export { msfilePlugin, msfileSetup, MSFILE_PLUGIN_ID, msfileResources } from "./manifest.js";
export { MsFileServiceProxy } from "./msfileServiceProxy.js";
export { MsFileSettings } from "./MsFileSettings.js";
export { MsFileHomeFileWidget } from "./MsFileHomeFileWidget.js";
export { MsFileBucketPage } from "./MsFileBucketPage.js";
export {
  MSFILE_BUCKET_SERVICE_CAPABILITY,
  createBrowserMsFileSeedSource,
  createMsFileBucketService,
  type MsFileBucketService,
} from "./msfileBucketService.js";
export {
  MSFILE_SEED_META_FORMAT,
  MSFILE_SEED_META_VERSION,
  MsFileSeedStoreError,
  deleteMsFileSeed,
  isMsFileSeedHashHex,
  isMsFileSeedStoreError,
  listMsFileSeeds,
  normalizeMsFileSeedMediaType,
  parseMsFileSeedMeta,
  readMsFileSeed,
  sanitizeMsFileSeedFileName,
  serializeMsFileSeedMeta,
  storeMsFileSeed,
  verifyMsFileSeed,
  type MsFileSeedEntry,
  type MsFileSeedMeta,
  type MsFileSeedReadResult,
  type MsFileSeedSource,
  type MsFileSeedStoreErrorCode,
  type MsFileSeedStoreProgress,
  type MsFileSeedUploadResult,
  type MsFileSeedVerifyResult,
} from "./storage/msfileSeedStore.js";
export {
  assembleMsFileBytes,
  assembleMsFileParts,
  createMsFileBlockPlan,
  expectedMsFileBlockCount,
  extractMsFileReadBytes,
  FileAssemblyError,
  parseMsFileUint64,
  parseSeedBlockPlan,
  readMsFileBlocksWithWorkerPool,
  sanitizeMsFileFilename,
  validateMsFileBlockResponse,
} from "./fileAssembly.js";
export {
  createMsFileIsolatedHtmlBlobUrl,
  decodeMsFileUtf8,
  decideMsFileHomePreview,
  firstMsFileBytes,
  hasMsFilePreviewSignature,
  normalizeMsFileMediaType,
} from "./filePreviewPolicy.js";
export { MsFileServiceError, type MsFileServiceErrorCode } from "./msfileErrors.js";
