// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import type { PasskeyProtection, VaultService } from "@keymaster/contracts";
import { CurrentKeySettingsPage } from "./CurrentKeySettingsPage.js";

const CURRENT_KEY = "02".padEnd(66, "a");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CurrentKeySettingsPage", () => {
  it("adds and removes protectors through current-key APIs without a password or public key", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PublicKeyCredential", class PublicKeyCredential {});
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {}
    });

    let passkeys: PasskeyProtection[] = [
      {
        id: "passkey-phone",
        label: "iPhone",
        rpId: "keymaster.cc",
        createdAt: "2026-07-17T00:00:00.000Z"
      }
    ];
    const addPasskeyToCurrentKey = vi.fn(async ({ label }: { label: string }) => {
      passkeys = [
        ...passkeys,
        {
          id: "passkey-laptop",
          label,
          rpId: "keymaster.cc",
          createdAt: "2026-07-18T00:00:00.000Z"
        }
      ];
      return passkeys.at(-1)!;
    });
    const removePasskeyFromCurrentKey = vi.fn(async ({ passkeyId }: { passkeyId: string }) => {
      passkeys = passkeys.filter((item) => item.id !== passkeyId);
    });
    const vault = {
      listCurrentKeyPasskeys: async () => passkeys,
      addPasskeyToCurrentKey,
      removePasskeyFromCurrentKey,
      exportCurrentKeyBackup: async () => "{}"
    } as unknown as VaultService;
    const host = createPluginHost({ disableConfigPersistence: true });
    host.capabilities.provide<VaultService>("vault.service", vault);
    host.capabilities.get<any>("resource.registry").register({
      id: "vault.key-state",
      scope: "global",
      key: () => ["vault.key-state"],
      load: async () => ({
        keys: [
          {
            publicKeyHex: CURRENT_KEY,
            label: "Primary",
            capabilities: ["p2pkh"],
            createdAt: "2026-07-17T00:00:00.000Z"
          }
        ],
        active: { activePublicKeyHex: CURRENT_KEY },
        initializing: false,
        notice: null
      }),
      subscribe: () => () => undefined,
      invalidation: "immediate"
    });

    render(
      <PluginHostProvider host={host}>
        <CurrentKeySettingsPage />
      </PluginHostProvider>
    );
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/Passkey 名称|Passkey name/i), "MacBook Touch ID");
    await user.click(screen.getByRole("button", { name: /添加 Passkey|Add Passkey/i }));
    await waitFor(() => {
      expect(addPasskeyToCurrentKey).toHaveBeenCalledWith({ label: "MacBook Touch ID" });
    });

    const phoneRow = (await screen.findByText("iPhone")).closest(".current-key-protector");
    expect(phoneRow).toBeTruthy();
    await user.click(phoneRow!.querySelector("button")!);
    await waitFor(() => {
      expect(removePasskeyFromCurrentKey).toHaveBeenCalledWith({ passkeyId: "passkey-phone" });
    });
  });
});
