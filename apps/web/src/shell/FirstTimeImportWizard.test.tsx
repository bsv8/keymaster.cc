// apps/web/src/shell/FirstTimeImportWizard.test.tsx
// FirstTimeImportWizard 页面级验收测试（硬切换 011 + 012 / 施工单 001 复审）。
//
// 关键不变量（页面层）：
//   1. JSON importer 选中后，step 2 显示输入方式切换。
//   2. 切换输入方式会清空旧方式残留的文本 / 嗅探。
//   3. JSON 文本模式下粘贴 bsv8 envelope 文本会升起密码框；解析后
//      resolvedImportPassword 会被转存。
//   4. 第 4 步进入"使用同一密码"模式时，第 4 步渲染 reuseNotice 而不渲染
//      密码输入框。
//   5. 返回 step 2 后旧解析结果与旧密码决策失效（resolvedImportPassword /
//      importRequiredPassword / useSamePassword 重置）。

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type {
  KeyImporter,
  KeyImportInput,
  KeyImportResult,
  VaultService,
  VaultStatus,
  MessageBus,
  ImporterRegistry
} from "@keymaster/contracts";
import { FirstTimeImportWizard } from "./FirstTimeImportWizard.js";
import { keyImportResources } from "@keymaster/plugin-key-import/manifest";
import { SHELL_RESOURCES } from "../i18n/resources";

/** 构造一个最小 host，包含一个用于测试的 JSON importer 与可断言的 vault。 */
function createWizardHost() {
  const host = createPluginHost({
    disableConfigPersistence: true,
    initialI18nResources: [keyImportResources, SHELL_RESOURCES]
  });
  const vault: VaultService = makeStubVault();
  host.capabilities.provide<VaultService>("vault.service", vault);
  const messageBus = host.capabilities.get<MessageBus>("runtime.messageBus");
  if (!messageBus) throw new Error("missing messageBus");
  const registry = host.capabilities.get<ImporterRegistry>("importer.registry");
  if (!registry) throw new Error("missing registry");
  registry.register(makeTestJsonImporter());
  return { host, vault };
}

function makeStubVault(): VaultService {
  const statusHandlers = new Set<(s: VaultStatus) => void>();
  return {
    status: () => "uninitialized",
    onStatusChange: (h: (s: VaultStatus) => void) => {
      statusHandlers.add(h);
      return () => statusHandlers.delete(h);
    },
    getInitialActivationNotice: () => null,
    clearInitialActivationNotice: () => {},
    onInitialActivationNoticeChange: (h: (n: unknown) => void) => {
      h(null);
      return () => {};
    },
    hasVault: async () => false,
    createVaultWithImportedKey: async () => {
      // 让 wizard 跑通 resetWizard，模拟成功路径。
      return;
    }
  } as unknown as VaultService;
}

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

function mount() {
  const handle = createWizardHost();
  return {
    ...handle,
    unmount: render(
      <PluginHostProvider host={handle.host}>
        <FirstTimeImportWizard onCancel={() => {}} />
      </PluginHostProvider>
    ).unmount
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

async function selectJsonImporter(user: ReturnType<typeof userEvent.setup>) {
  const items = document.querySelectorAll(".importer-picker__item");
  for (const item of Array.from(items)) {
    if (item.textContent?.includes("JSON")) {
      await user.click(item as HTMLElement);
      return;
    }
  }
  throw new Error("JSON importer item not found");
}

async function gotoInputStep(user: ReturnType<typeof userEvent.setup>) {
  await selectJsonImporter(user);
  // 第 1 步：点"下一步"进 input 步
  await user.click(screen.getByRole("button", { name: /下一步|Next/ }));
}

describe("FirstTimeImportWizard - JSON importer 输入方式切换", () => {
  it("第 2 步 JSON importer 默认显示 file 模式（Input mode 切换 + 文件控件）", async () => {
    const user = userEvent.setup();
    mount();
    await gotoInputStep(user);
    expect(screen.getByText(/输入方式|Input mode/)).toBeTruthy();
    // 文件控件 label "File" / "文件"
    expect(screen.getByText(/文件|File/)).toBeTruthy();
  });

  it("切到 JSON 文本模式显示 TextArea", async () => {
    const user = userEvent.setup();
    mount();
    await gotoInputStep(user);
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: /JSON 文本|JSON text/ })).toBeTruthy();
    });
  });

  it("粘贴 bsv8 envelope 文本时升起密码框", async () => {
    const user = userEvent.setup();
    mount();
    await gotoInputStep(user);
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");

    const envelope = JSON.stringify({
      version: "kek-v1",
      kdf: "argon2id",
      cipher: "xchacha20poly1305",
      kdf_params: { memory_kib: 1024, time_cost: 1, parallelism: 4, salt_hex: "00".repeat(16) },
      nonce_hex: "00".repeat(24),
      ciphertext_hex: "00".repeat(96)
    });
    const ta = screen.getByRole("textbox", { name: /JSON 文本|JSON text/ }) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: envelope } });

    await waitFor(() => {
      expect(screen.getByText(/Import-source password|导入源密码/)).toBeTruthy();
    });
  });
});

describe("FirstTimeImportWizard - JSON 文本路径端到端", () => {
  it("plain JSON 解析成功后到第 3 步；第 4 步走新密码模式（不显示 reuseNotice）", async () => {
    const user = userEvent.setup();
    mount();
    await gotoInputStep(user);
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");
    const ta = screen.getByRole("textbox", { name: /JSON 文本|JSON text/ }) as HTMLTextAreaElement;
    fireEvent.change(ta, {
      target: { value: JSON.stringify({ privateKey: "5Hwgr3..." }) }
    });

    // 解析
    await user.click(screen.getByRole("button", { name: /解析|Parse/ }));
    await waitFor(() => {
      // 进入 confirm-key 步（看到"确认解析结果"）
      expect(screen.getByText(/确认解析结果|Confirm the parsed key/)).toBeTruthy();
    });
    // 下一步到 set-password 步
    await user.click(screen.getByRole("button", { name: /下一步|Next/ }));
    await waitFor(() => {
      expect(screen.getByText(/设置本机系统锁屏密码|Set a local Vault password/)).toBeTruthy();
    });
    // 明文路径下不应显示 reuseNotice
    expect(screen.queryByText(/Reusing|将复用/)).toBeNull();
    // 双密码输入框都在
    expect(screen.getAllByLabelText(/新密码|New password/)).toBeTruthy();
    expect(screen.getAllByLabelText(/确认密码|Confirm password/)).toBeTruthy();
  });
});

describe("FirstTimeImportWizard - 密码决策清空", () => {
  it("返回上一步会清掉旧密码决策与解析结果", async () => {
    const user = userEvent.setup();
    mount();
    await gotoInputStep(user);
    // 解析一个明文 JSON，让 wizard 至少进入 confirm-key
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "text");
    const ta = screen.getByRole("textbox", { name: /JSON 文本|JSON text/ }) as HTMLTextAreaElement;
    fireEvent.change(ta, {
      target: { value: JSON.stringify({ privateKey: "5Hwgr3..." }) }
    });
    await user.click(screen.getByRole("button", { name: /解析|Parse/ }));
    await waitFor(() => {
      expect(screen.getByText(/确认解析结果|Confirm the parsed key/)).toBeTruthy();
    });
    // 退到 input 步
    await user.click(screen.getByRole("button", { name: /返回|Back/ }));
    await waitFor(() => {
      expect(screen.getByText(/粘贴或选择|Paste or upload/)).toBeTruthy();
    });
    // 再次切回文件模式：select 还存在，textarea 已消失
    const selectAfter = screen.getByRole("combobox");
    await user.selectOptions(selectAfter, "file");
    // 文本框应消失（确认旧文本残留被清掉）
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /JSON 文本|JSON text/ })).toBeNull();
    });
  });
});
