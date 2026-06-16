// packages/contracts/src/i18n.ts
// 前端多语言公共契约：i18n 文本、I18nService、插件资源、capability key。
//
// 设计缘由：
//   - 平台 UI 文案是 registry（route/menu/breadcrumb/settings/home/topbar 等）
//     的展示属性；硬切换前这些属性是 `string`，硬切换后必须是 `I18nText`。
//     `I18nText` 包含 `key + fallback + values`，渲染层根据当前语言查表，
//     缺 key 时退回 fallback，再缺时显示 key。
//   - 错误信息（`Error.message`）继续用英文；UI 给用户看的摘要才走本地化。
//   - 插件资源由 `I18nPluginResources` 描述：每个插件声明自己的 namespace，
//     资源由 runtime 在 setup 之前统一注册到 i18n service，避免 setup 中
//     `t()` 把当前语言固化在 registry 文本里。

/** 系统支持的语言稳定短码。集中定义，禁止插件自行扩展。 */
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 默认系统语言。 */
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

/** 语言显示描述。 */
export interface SupportedLanguageDescriptor {
  /** 短码，必须在 SUPPORTED_LANGUAGES 中。 */
  code: SupportedLanguage;
  /** 平台层展示名（用 i18nText 描述自身名不应循环依赖，此处用 I18nText 自身）。 */
  label: I18nText;
  /** BCP 47 形式的 html lang 属性值。 */
  htmlLang: string;
}

/** 模式：手动指定语言 / 跟随浏览器。 */
export type LanguageMode = "auto" | "manual";

/** 插值变量集合。键为 i18n 资源里的 `{{key}}` 占位。 */
export type I18nValues = Record<string, string | number | boolean | null | undefined>;

/**
 * 平台 UI 文案描述。
 *
 * 字段含义：
 *   - `string`：兼容输入与极少不可翻译的纯文本（例如稳定 code）；
 *     不作为新增 UI 文案的主路径。
 *   - `{ key, fallback, values? }`：新增与迁移后的平台 UI 文案统一形态。
 *     `key` 是 i18n 资源里的命名空间路径，例如 `home.route.label`；
 *     `fallback` 是默认语言缺 key 时的可见兜底，不是主要翻译源；
 *     `values` 用于 `{{name}}` 等插值变量。
 */
export type I18nText =
  | string
  | {
      key: string;
      fallback: string;
      values?: I18nValues;
    };

/** 插件 i18n 资源：runtime 在 plugin setup 之前注入。 */
export interface I18nPluginResources {
  /** 命名空间；同一插件内所有 key 落在该命名空间下。 */
  namespace: string;
  /**
   * 资源集合：键为语言 code，值为该命名空间下的 key-value map。
   * 缺语言时 fallback 到 `en`，再缺时显示 fallback。
   */
  resources: Partial<Record<SupportedLanguage, Record<string, string>>>;
}

/** 监听语言变化的回调。 */
export type LanguageChangeHandler = (language: SupportedLanguage) => void;

/**
 * I18nService：业务组件 / registry 渲染点 / settings UI 共用入口。
 *
 * 设计缘由：
 *   - `t()` 给组件外的 registry 渲染点使用（registry label、settings options 等）。
 *   - `text()` 统一处理 `I18nText`、fallback、缺 key。
 *   - `registerResources()` 让插件按 namespace 提供自己的资源；runtime 在
 *     plugin setup 之前统一注册，避免 setup 中 `t()` 把当前语言固化到 registry。
 *   - `onChange()` 让 shell、settings、registry 渲染点在语言切换后重渲染。
 */
export interface I18nService {
  /** 当前模式：手动 / 跟随浏览器。 */
  mode(): LanguageMode;
  /** 当前语言（始终在 SUPPORTED_LANGUAGES 内）。 */
  language(): SupportedLanguage;
  /** 支持的语言清单（用于 settings UI）。 */
  supported(): readonly SupportedLanguageDescriptor[];

  /**
   * 按 key 取翻译；缺 key 时返回 key 本身（开发/测试可监听 warning）。
   * 不做 I18nText 解析，调用方应使用 `text()` 处理复合输入。
   */
  t(key: string, values?: I18nValues): string;

  /**
   * 处理 I18nText：
   *   - string：原样返回（不翻译，作为兼容输入）；
   *   - undefined：返回空字符串；
   *   - { key, fallback, values }：先 t(key, values)，命中则返回；否则返回 fallback。
   */
  text(input: I18nText | undefined): string;

  /**
   * 切换到指定语言并持久化为手动选择。
   * localStorage 写入失败不影响内存切换；调用方无须捕获。
   */
  setLanguage(language: SupportedLanguage): Promise<void>;

  /**
   * 切回跟随浏览器模式：清除手动语言覆盖，刷新后按浏览器语言重新映射。
   */
  setAuto(): Promise<void>;

  /**
   * 注册插件资源（runtime 在 plugin setup 之前调用，插件不要直接调用）。
   * 重复 namespace 合并：相同 key 后续注册覆盖前值。
   */
  registerResources(pluginId: string, resources: I18nPluginResources): void;

  /**
   * 硬切换 001：注销指定插件注册过的 i18n 资源。
   * 重复调用安全；pluginId 没有注册过资源时 no-op。
   * 设计缘由：host 在 disable / unregister 流程回收插件 i18n 资源，
   * 避免同一 namespace 在多次 enable / disable 后出现 key 残留。
   */
  unregisterResources(pluginId: string): void;

  /** 订阅语言变更；返回取消订阅函数。 */
  onChange(handler: LanguageChangeHandler): () => void;
}

/** I18nService capability key。 */
export const I18N_SERVICE_CAPABILITY = "i18n.service";
