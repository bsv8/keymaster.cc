/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** CI 注入的不可变源码构建身份；正式生命周期证据必须使用该值。 */
  readonly VITE_KEYMASTER_BUILD_ID?: string;
}
