/// <reference types="vite/client" />

/** 由产品入口显式启用，测试构建覆盖为 false。 */
declare const __KEYMASTER_PRODUCT_SERVICES__: boolean;

interface ImportMetaEnv {
  /** CI 注入的不可变源码构建身份；正式生命周期证据必须使用该值。 */
  readonly VITE_KEYMASTER_BUILD_ID?: string;
}
