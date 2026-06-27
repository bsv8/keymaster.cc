// packages/plugin-key-import/src/testSupport/createTestHost.ts
// 构造一个最小可用的 PluginHost，专门用于 ImportPage / FirstTimeImportWizard
// 等依赖 plugin host 能力的 React 组件测试。
//
// 设计缘由：
//   - ImportPage 调 useCapability 拿 vault.service / importer.registry /
//     runtime.messageBus / i18n.service；这些必须由 host 真正 provide 才能
//     让 useCapability 找到。
//   - 不引入 jsdom-style 全栈测试基础设施；只构造一个 host 对象，再用
//     @testing-library/react 渲染组件即可。
//   - 测试用 host 不写 localStorage / IndexedDB（用 disableConfigPersistence
//     与 host 内的 in-memory storage 即可）。
//   - 我们不能跨包边界 import plugin-importer-json-file，所以这里直接造
//     一个最小的 JSON importer 用于 ImportPage 测试。

import { createPluginHost } from "@keymaster/runtime";
import type {
  I18nPluginResources,
  ImporterRegistry,
  KeyImporter,
  KeyImportInput,
  KeyImportResult,
  MessageBus,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { keyImportResources } from "../manifest.js";

export interface TestHostOptions {
  /** 额外的 importer 注册到 importer.registry。 */
  extraImporters?: KeyImporter[];
  /** vault 状态；默认 "unlocked"。 */
  vaultStatus?: VaultStatus;
}

export interface TestHostHandle {
  host: ReturnType<typeof createPluginHost>;
  vault: VaultService;
  messageBus: MessageBus;
  importers: KeyImporter[];
}

/**
 * 测试用 JSON importer：仅支持 text 与 file 输入，simulate parse 行为。
 * 不真做 bsv8 解密；解析只验证输入形态，return 一个固定结果。
 */
function makeTestJsonImporter(): KeyImporter {
  return {
    id: "json-file",
    name: "JSON",
    description: "",
    supports: ["text", "file"],
    async parse(input: KeyImportInput): Promise<KeyImportResult[]> {
      const text =
        input.kind === "text"
          ? input.text
          : new TextDecoder().decode(input.content);
      try {
        JSON.parse(text);
      } catch (err) {
        throw new Error(
          `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return [
        {
          material: { hex: "00".repeat(32) },
          address: "",
          detectedFormat: "json-file"
        }
      ];
    }
  };
}

/** 构造一个满足 ImportPage 依赖的最小 host。 */
export function createTestHost(opts: TestHostOptions = {}): TestHostHandle {
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [keyImportResources]
  });
  const vault = makeStubVault(opts.vaultStatus ?? "unlocked");
  host.capabilities.provide<VaultService>("vault.service", vault);
  const messageBus = host.capabilities.get<MessageBus>("runtime.messageBus");
  if (!messageBus) throw new Error("runtime.messageBus missing in test host");
  const registry = host.capabilities.get<ImporterRegistry>("importer.registry");
  if (!registry) throw new Error("importer.registry missing in test host");
  const importers = [makeTestJsonImporter(), ...(opts.extraImporters ?? [])];
  for (const imp of importers) {
    registry.register(imp);
  }
  return { host, vault, messageBus, importers };
}

function makeStubVault(initialStatus: VaultStatus): VaultService {
  let status: VaultStatus = initialStatus;
  const statusHandlers = new Set<(s: VaultStatus) => void>();
  const noticeHandlers = new Set<(n: unknown) => void>();
  return {
    status: () => status,
    onStatusChange: (h: (s: VaultStatus) => void) => {
      statusHandlers.add(h);
      return () => statusHandlers.delete(h);
    },
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => {},
    onInitialActivationNoticeChange: (h: (n: unknown) => void) => {
      noticeHandlers.add(h);
      h(null);
      return () => noticeHandlers.delete(h);
    },
    hasVault: async () => status !== "uninitialized",
    importPrivateKey: async (..._args: unknown[]) => {
      throw new Error("not implemented in test stub");
    },
    createVaultWithImportedKey: async (..._args: unknown[]) => {
      throw new Error("not implemented in test stub");
    }
  } as unknown as VaultService;
}
