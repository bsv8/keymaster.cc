/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** CI 注入的不可变源码构建身份；正式生命周期证据必须使用该值。 */
  readonly VITE_KEYMASTER_BUILD_ID?: string;
  /** 仅构建无头 MSFile 跨仓 E2E 时设为 "1"；正常产品构建必须缺省。 */
  readonly VITE_MSFILE_E2E?: string;
  /** 仅运行旧 executor spike E2E 时设为 "1"；正常产品构建必须缺省。 */
  readonly VITE_MSFILE_SPIKE?: string;
}

declare module "virtual:keymaster-msfile-e2e-hooks" {
  import type { PluginHost } from "@keymaster/runtime";
  export function installMsFileProductionE2EHooks(host: PluginHost): void;
  export function installLifecycleProductionE2EHooks(host: PluginHost): void;
}

declare module "virtual:keymaster-msfile-spike-hooks" {
  export function installMsFileSpikeHooks(): void;
}
