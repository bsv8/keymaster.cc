/// <reference types="vite/client" />

/** 由产品入口显式启用，测试构建覆盖为 false。 */
declare const __KEYMASTER_PRODUCT_SERVICES__: boolean;

interface ImportMetaEnv {
  /** 仅 development/dev mode 使用；完整目录替换，[] 表示无仲裁。 */
  readonly VITE_KEYMASTER_DEV_ARBITRATION_SERVICES?: string;
  /** 临时默认 SatSubscription 网关 JSON，不写入钱包设置。 */
  readonly VITE_KEYMASTER_DEV_SAT_SUPPLIER?: string;
  /** CI 注入的不可变源码构建身份；正式生命周期证据必须使用该值。 */
  readonly VITE_KEYMASTER_BUILD_ID?: string;
}
