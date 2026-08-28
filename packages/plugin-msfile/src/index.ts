// packages/plugin-msfile/src/index.ts
// 页面侧公共出口。Worker 侧请使用 `@keymaster/plugin-msfile/coordinator`。

export { msfilePlugin, MSFILE_PLUGIN_ID, msfileResources } from "./manifest.js";
export { MsFileServiceProxy } from "./msfileServiceProxy.js";
export { MsFileSettings } from "./MsFileSettings.js";
export { MsFileHomeFileWidget } from "./MsFileHomeFileWidget.js";
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
