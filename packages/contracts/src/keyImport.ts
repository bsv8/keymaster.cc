// packages/contracts/src/keyImport.ts
// 私钥导入契约：plugin-key-import 是平台，importer-* 是格式实现。
// Importer 只负责解析输入并返回标准 PrivateKeyMaterial，禁止直接写 Vault。

import type { BsvNetwork, PrivateKeyMaterial } from "./vault.js";
import type { I18nText } from "./i18n.js";

/**
 * Importer 输入类型。
 * 设计缘由：加密文件（如 bsv8 envelope）的备份密码属于本次 parse 的瞬时输入，
 * 不能放到 importer 实例或 React 全局状态里；它只在 file input 上随本次解析
 * 一次性传递，parse 结束后由调用方负责清空。
 */
export type KeyImportInput =
  | { kind: "text"; text: string }
  | { kind: "file"; name: string; content: Uint8Array; password?: string };

/** 单条解析结果。 */
export interface KeyImportResult {
  /** 私钥材料。 */
  material: PrivateKeyMaterial;
  /** 派生的 BSV 地址。 */
  address: string;
  /** 推断的网络；未指定时由调用方决定。 */
  network?: BsvNetwork;
  /**
   * 解析时观察到的格式，例如 "wif-mainnet"、"bsv8-key-envelope"。
   * 设计缘由：detectedFormat 是稳定业务 code，不翻译；UI 层可以另外用
   * i18n key 把它翻译为 "WIF 私钥 (main)" 之类的展示。
   */
  detectedFormat: string;
  /**
   * 解析时给用户看的展示摘要，硬切换后为 I18nText。
   * 设计缘由：旧实现是 string 例如 "Compressed WIF, mainnet"，
   * 翻译后变为 { key, fallback } 形式；fallback 用英文（开发期可见），
   * en/zh-CN 资源里覆盖具体翻译。
   */
  summary?: I18nText;
}

/** Importer 描述。 */
export interface KeyImporter {
  /** importer 唯一 id，使用命名空间，例如 "wif"、"hex"、"json-file"。 */
  id: string;
  /**
   * 展示用名称。硬切换后为 I18nText；
   * WIF / Hex / JSON File 这类稳定 code 不强制翻译，importer 可用 string。
   */
  name: I18nText;
  /** 简短描述。 */
  description?: I18nText;
  /** 支持的输入类型。 */
  supports: Array<KeyImportInput["kind"]>;
  /** 解析输入；失败时抛错。 */
  parse(input: KeyImportInput): Promise<KeyImportResult[]>;
}

/** Importer 注册表，由 plugin-key-import 提供。 */
export interface ImporterRegistry {
  /** 注册 importer；id 重复抛错。 */
  register(importer: KeyImporter): void;
  /** 列出全部 importer。 */
  list(): KeyImporter[];
  /** 找到能处理该输入的第一个 importer。 */
  match(input: KeyImportInput): KeyImporter | undefined;
  /** 按 id 取 importer。 */
  get(id: string): KeyImporter | undefined;
}
