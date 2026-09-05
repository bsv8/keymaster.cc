// 页面装配层只需要 Storage grant authority；保持该入口不加载 S3 SDK。
export { createStorageBindingAuthority } from "./storageBindingAuthority.js";
