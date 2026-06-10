// packages/runtime/src/i18n/createI18nService.ts
// 创建 i18next 实例并包装为 I18nService。
//
// 设计缘由：
//   - 用 i18next 做底层翻译引擎：i18next 支持 namespace / fallback / 插值 / 复数
//     / 运行时 changeLanguage；react-i18next 不直接在这里出现，由 hooks 层引入。
//   - 资源按 namespace 注入：每个插件 manifest.i18n 提供一个 namespace；
//     同一 namespace 重复注册合并，后注册覆盖前值。
//   - 默认 fallback 到 DEFAULT_LANGUAGE；缺资源时不静默回退到 key（便于测试 fail visible）。
//   - changeLanguage 完成后才 emit onChange；订阅者拿到的状态与 i18next 内部一致。

import {
  DEFAULT_LANGUAGE,
  I18N_SERVICE_CAPABILITY,
  SUPPORTED_LANGUAGES,
  type I18nPluginResources,
  type I18nService,
  type I18nText,
  type I18nValues,
  type LanguageMode,
  type SupportedLanguage,
  type SupportedLanguageDescriptor
} from "@keymaster/contracts";
import i18next, { type i18n as I18nInstance } from "i18next";
import {
  getLanguage,
  getLanguageMode,
  setAutoLanguage,
  setLanguage as setStoreLanguage,
  subscribe as subscribeStore
} from "./i18nStore.js";

/**
 * Common 公共 namespace：放跨插件复用的基础动作文案，例如
 * common.action.save / common.action.cancel / settings.language.* 等。
 * runtime 在创建 service 时先注册空对象；具体 key 由 plugin-settings 等模块在 i18n 资源中覆盖。
 */
const COMMON_NS = "common";

/** 平台层 i18n 资源：覆盖 common.* 与全局兜底文案。 */
const PLATFORM_RESOURCES: I18nPluginResources = {
  namespace: COMMON_NS,
  resources: {
    en: {
      "common.action.save": "Save",
      "common.action.cancel": "Cancel",
      "common.action.confirm": "Confirm",
      "common.action.close": "Close",
      "common.action.delete": "Delete",
      "common.action.export": "Export",
      "common.action.create": "Create",
      "common.action.refresh": "Refresh",
      "common.action.unlock": "Unlock",
      "common.action.lock": "Lock",
      "common.action.back": "Back",
      "common.status.loading": "Loading…",
      "common.status.empty": "No data",
      "common.locale.en": "English",
      "common.locale.zh-CN": "Simplified Chinese",
      "common.menu.close": "Close menu"
    },
    "zh-CN": {
      "common.action.save": "保存",
      "common.action.cancel": "取消",
      "common.action.confirm": "确认",
      "common.action.close": "关闭",
      "common.action.delete": "删除",
      "common.action.export": "导出",
      "common.action.create": "创建",
      "common.action.refresh": "刷新",
      "common.action.unlock": "解锁",
      "common.action.lock": "锁定",
      "common.action.back": "返回",
      "common.status.loading": "加载中…",
      "common.status.empty": "暂无数据",
      "common.locale.en": "English",
      "common.locale.zh-CN": "简体中文",
      "common.menu.close": "关闭菜单"
    }
  }
};

export interface CreateI18nServiceOptions {
  /**
   * 启动前注入的资源。
   * 设计缘由：apps/web 是装配层，可以在 createPluginHost 时把 shell
   * 自己的 i18n 资源（如 `shell.locked.*`）先注入到 i18n service，
   * 保证 Topbar / LockedShell 的 t() 调用能命中。
   *
   * 注意：这里传入的 resources 包含 platform 自身需要的额外 namespace；
   * 其它 plugin 资源在 registerPlugin 时由 createPluginHost 通过
   * i18n.registerResources() 注入。
   */
  initialResources?: I18nPluginResources[];
  /**
   * 开发模式下输出缺 key warning。
   * 默认：非生产模式（检测 Vite/Node 环境）。
   */
  debug?: boolean;
}

/** 安全地探测当前是否为生产模式。避免直接访问 process（runtime 包
 * 可能在没有 node types 的浏览器中被打包）。 */
function detectProduction(): boolean {
  try {
    // Vite 在浏览器侧会把 import.meta.env 替换成对象；这里 typeof 守卫
    // 是为了不让 TS 把这段代码看作 node 代码。
    const meta = (import.meta as ImportMeta & { env?: { MODE?: string; DEV?: boolean } });
    if (meta.env) {
      if (typeof meta.env.MODE === "string") return meta.env.MODE === "production";
      if (typeof meta.env.DEV === "boolean") return !meta.env.DEV;
    }
  } catch {
    // 忽略
  }
  // Node / 测试环境：通过 globalThis 访问 process，避免触发 TS 全局 process 类型。
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  if (g.process?.env) {
    return g.process.env.NODE_ENV === "production";
  }
  return false;
}

export interface CreateI18nServiceOptions {
  /**
   * 启动前注入的资源（仅 platform common 资源）。其它插件资源在
   * registerPlugin 时由 createPluginHost 通过 i18n.registerResources() 注入。
   */
  initialResources?: I18nPluginResources[];
  /**
   * 开发模式下输出缺 key warning。
   * 默认：process.env.NODE_ENV !== "production"。
   */
  debug?: boolean;
}

export function createI18nService(options: CreateI18nServiceOptions = {}): I18nService {
  const debug = options.debug ?? !detectProduction();
  const initial = new Map<string, Record<string, string>>();
  // 收集所有 namespace：service.t() 解析 "ns.key" 时用它判断 ns 前缀。
  // initialResources 里声明的 namespace 必须在 splitKey 看到第一段
  // "ns" 时就认账——否则 shell.* / vault.* 这类 key 会被错认成 common。
  const loadedNamespaces = new Set<string>([COMMON_NS]);
  // 始终先注入 common 资源，保证 platform 兜底可用。
  for (const [lang, map] of Object.entries(PLATFORM_RESOURCES.resources)) {
    if (!map) continue;
    if (!SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) continue;
    initial.set(`${lang}#${COMMON_NS}`, map);
  }
  for (const r of options.initialResources ?? []) {
    loadedNamespaces.add(r.namespace);
    for (const [lang, map] of Object.entries(r.resources)) {
      if (!map) continue;
      if (!SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) continue;
      const key = `${lang}#${r.namespace}`;
      const prev = initial.get(key) ?? {};
      initial.set(key, { ...prev, ...map });
    }
  }

  const i18n = createI18nInstance(initial, [...loadedNamespaces], debug);

  // 订阅 store 变化：手动切换或 setAuto 时把 i18next 切到对应语言。
  // changeLanguage 是异步的；这里用 i18n.changeLanguage 的 Promise resolve
  // 作为 onChange 触发点，确保 setLanguage() await 完成时 handler 已收到
  // 新 language。
  const offStore = subscribeStore((s) => {
    void i18n.changeLanguage(s.language);
  });
  // 用 i18nStore 的当前语言初始化一次；后续切语言走 changeLanguage。
  const initialLang = getLanguage();
  void i18n.changeLanguage(initialLang);

  return {
    mode: () => getLanguageMode(),
    language: () => getLanguage(),
    supported: () => buildSupportedDescriptors(i18n),
    t(key, values) {
      // 解析 "ns.key" -> { ns, key }：i18next 默认不识别 "." 作为
      // namespace separator（默认是 ":"），所以我们手动拆。
      const { ns, key: actualKey } = splitKey(key, loadedNamespaces);
      return i18n.t(actualKey, { ...(values as Record<string, unknown> | undefined), ns });
    },
    text(input) {
      if (input == null) return "";
      if (typeof input === "string") return input;
      const { key, fallback, values } = input;
      const { ns, key: actualKey } = splitKey(key, loadedNamespaces);
      const translated = i18n.t(actualKey, { ...(values as Record<string, unknown> | undefined), ns });
      // i18next 缺 key 时原样返回 key；按施工单要求此时回退到 fallback。
      if (!translated || translated === key) {
        return fallback ?? key;
      }
      return translated;
    },
    async setLanguage(language) {
      // 等到 i18next.changeLanguage 完成 emit languageChanged 后再返回，
      // 让 setLanguage 后的 useI18n 重渲染读到的 language 与 i18n 内部一致。
      setStoreLanguage(language);
      await i18n.changeLanguage(language);
    },
    async setAuto() {
      // setAutoLanguage 内部会读浏览器语言再决定最终 language。
      // 我们等 i18n.changeLanguage 跟随后再返回。
      setAutoLanguage();
      await i18n.changeLanguage(getLanguage());
    },
    registerResources(pluginId, resources) {
      // 合并到 i18n 实例：相同 namespace 后注册覆盖前值。
      // 首次见到 namespace 时把它加进 i18n.options.ns（同步），让
      // t("ns.key") 立即命中。addResourceBundle 已经把资源塞进 store。
      for (const [lang, map] of Object.entries(resources.resources)) {
        if (!map) continue;
        if (!SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) continue;
        i18n.addResourceBundle(lang, resources.namespace, map, true, true);
      }
      if (!loadedNamespaces.has(resources.namespace)) {
        loadedNamespaces.add(resources.namespace);
        // 直接修改 i18n.options.ns（i18next 在 t() 调用时会读这个数组）。
        // 这一步让 "sample.greet" 这种带 namespace 前缀的 key 立即可解析。
        const opts = i18n.options as { ns?: string[] };
        if (Array.isArray(opts.ns)) {
          opts.ns.push(resources.namespace);
        } else {
          opts.ns = [COMMON_NS, resources.namespace];
        }
      }
    },
    onChange(handler) {
      // i18next 自身是 EventEmitter，languageChanged 事件在
      // i18n.changeLanguage() 完成 resolve 后 emit。on() 不返回 unsubscribe；
      // 取消订阅需要调 off(event, listener)。这里保存 listener 引用。
      const i18nEmitter = i18n as unknown as {
        on: (ev: string, cb: (...args: unknown[]) => void) => unknown;
        off: (ev: string, cb: (...args: unknown[]) => void) => void;
      };
      const listener = () => {
        handler(getLanguage());
      };
      i18nEmitter.on("languageChanged", listener);
      return () => {
        offStore();
        i18nEmitter.off("languageChanged", listener);
      };
    }
  };
}

/** 把 "ns.key" 解析成 { ns, key }。设计缘由：i18next 默认用 ":" 作为
 * namespace separator；本项目使用 "." 更符合常见 i18n 库习惯。插件资源
 * 里 key 形如 "vault.route.unlock"——带着 namespace 前缀——直接以 flat
 * key 形式注册到 vault namespace 下。因此"已知 namespace"分支要把整串
 * 保留给 i18n.t，让 i18next 在 flat resource 中按完整字符串命中；只有
 * head 不是已知 namespace 时才把整串当 common namespace 下的 key。
 */
function splitKey(raw: string, knownNamespaces: ReadonlySet<string>): { ns: string; key: string } {
  const dot = raw.indexOf(".");
  if (dot < 0) {
    return { ns: COMMON_NS, key: raw };
  }
  const head = raw.slice(0, dot);
  if (knownNamespaces.has(head)) {
    // 已知 namespace：整串（含 head）作为 key 传给 i18n.t。
    // i18next 在 flat resource 下会用完整 key 字符串做查找。
    return { ns: head, key: raw };
  }
  // 头不是已知 namespace：整串当 key 走 defaultNS。
  return { ns: COMMON_NS, key: raw };
}

function buildSupportedDescriptors(i18n: I18nInstance): readonly SupportedLanguageDescriptor[] {
  return SUPPORTED_LANGUAGES.map((code) => ({
    code,
    label: {
      key: `common.locale.${code}`,
      fallback: code
    },
    htmlLang: code
  }));
}

function createI18nInstance(
  initial: Map<string, Record<string, string>>,
  namespaces: string[],
  debug: boolean
): I18nInstance {
  const instance = i18next.createInstance();
  // 把 initial map 拆成多 namespace / language 资源。
  const resources: Record<string, Record<string, Record<string, string>>> = {};
  for (const [combined, map] of initial) {
    const [lang, ns] = combined.split("#");
    if (!lang || !ns) continue;
    resources[lang] ??= {};
    resources[lang][ns] = map;
  }
  // ns 数组必须包含所有"已注入资源"的 namespace，否则 i18next 内部
  // lookup 不会去找这个 ns，splitKey 选对了 ns 也无济于事。
  // 兜底带上 common（一般已经被传入，但保险）。
  const nsList = namespaces.includes(COMMON_NS) ? namespaces : [COMMON_NS, ...namespaces];
  void instance.init({
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: nsList,
    defaultNS: COMMON_NS,
    fallbackNS: COMMON_NS,
    interpolation: { escapeValue: false },
    returnEmptyString: false,
    saveMissing: debug,
    missingKeyHandler: debug
      ? (lngs, ns, key) => {
          // 开发期：缺 key 暴露为 console warning；测试中也能被 console 看到。
          // eslint-disable-next-line no-console
          console.warn(`[i18n] missing key "${key}" (ns=${ns}, lng=${lngs.join(",")})`);
        }
      : undefined,
    resources
  });
  return instance;
}

export { I18N_SERVICE_CAPABILITY };
export type { LanguageMode };
