// packages/plugin-vault/src/VaultKeyBackupImportModal.test.tsx
// 单 Key Backup 导入 modal 回归测试。
//
// 关键不变量：
//   - 源密码 / 目标 Vault 密码必须原样透传，不能在 UI 层 trim；
//   - 成功时调用 vault.importKeyBackup 并关闭 modal。

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type { KeyRef, VaultService } from "@keymaster/contracts";
import { VaultKeyBackupImportModal } from "./VaultKeyBackupImportModal.js";

function makeVault() {
  const importKeyBackup = vi.fn(async (_input: {
    backup: string;
    sourcePassword: string;
    targetPassword: string;
  }) => {
    return {
      publicKeyHex: "02".padEnd(66, "a"),
      label: "restored",
      format: "hex",
      capabilities: ["p2pkh"],
      createdAt: "2026-07-17T00:00:00.000Z"
    } satisfies KeyRef;
  });
  return {
    importKeyBackup
  } as unknown as VaultService & { importKeyBackup: typeof importKeyBackup };
}

function mount(vault = makeVault()) {
  const host = createPluginHost({ disableConfigPersistence: true });
    return {
      vault,
      ...render(
      <PluginHostProvider host={host}>
        <VaultKeyBackupImportModal open vault={vault} onClose={vi.fn()} />
      </PluginHostProvider>
    )
  };
}

afterEach(() => {
  cleanup();
});

describe("VaultKeyBackupImportModal", () => {
  it("passes source/target passwords through without trimming", async () => {
    const vault = makeVault();
    mount(vault);

    fireEvent.change(screen.getByLabelText("备份 JSON"), {
      target: { value: '{"backupVersion":1}' }
    });
    fireEvent.change(screen.getByLabelText("源密码"), {
      target: { value: "  source-pass  " }
    });
    fireEvent.change(screen.getByLabelText("目标 Vault 密码"), {
      target: { value: "  target-pass  " }
    });

    fireEvent.click(screen.getByRole("button", { name: /恢复备份|Restore backup/ }));

    await waitFor(() => {
      expect((vault.importKeyBackup as typeof vault.importKeyBackup).mock.calls).toHaveLength(1);
    });

    const calls = (vault.importKeyBackup as typeof vault.importKeyBackup).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({
      backup: '{"backupVersion":1}',
      sourcePassword: "  source-pass  ",
      targetPassword: "  target-pass  "
    });
  });
});
