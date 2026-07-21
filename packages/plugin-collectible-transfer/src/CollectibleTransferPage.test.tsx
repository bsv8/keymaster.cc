// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import type { CollectibleDetail, CollectibleProvider, CollectibleTransferHandler } from "@keymaster/contracts";
import { createPluginHost, PluginHostProvider } from "@keymaster/runtime";
import { CollectibleTransferPage } from "./CollectibleTransferPage.js";
import { collectibleTransferPlugin } from "./manifest.js";

const RECIPIENT = "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DETAIL: CollectibleDetail = {
  summary: { providerId: "provider-a", collectibleId: "collectible-a", name: "Collectible A", status: "ready" }
};

function provider(getCollectible = vi.fn(async () => DETAIL)): CollectibleProvider {
  return {
    id: "provider-a", name: "Provider A", listCollectibles: async () => [DETAIL.summary], getCollectible,
    listActivity: async () => [], sync: async () => undefined, onChange: () => () => undefined
  };
}

function handler(id: string, order: number, supportsRecipient = () => true): CollectibleTransferHandler {
  return {
    id, name: id, order, supports: (ref) => ref.providerId === "provider-a" && ref.collectibleId === "collectible-a",
    supportsRecipientPublicKeyHex: supportsRecipient,
    component: ({ collectibleRef, detail, recipientPublicKeyHex }) => (
      <div data-testid="widget" data-ref={`${collectibleRef.providerId}/${collectibleRef.collectibleId}`} data-name={String(detail.summary.name)} data-recipient={recipientPublicKeyHex ?? ""}>{id}</div>
    )
  };
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children; }
}

function renderPage(options: { handlers?: CollectibleTransferHandler[]; getCollectible?: ReturnType<typeof vi.fn> } = {}) {
  const host = createPluginHost({ disableConfigPersistence: true, initialI18nResources: [collectibleTransferPlugin.i18n!] });
  host.collectibles.register(provider(options.getCollectible));
  for (const item of options.handlers ?? [handler("handler-a", 1)]) host.collectibleTransfer.register(item);
  return render(<PluginHostProvider host={host}><ErrorBoundary><CollectibleTransferPage /></ErrorBoundary></PluginHostProvider>);
}

describe("CollectibleTransferPage recipient target", () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

  it("parses the URL target and passes the canonical recipient to the selected widget", async () => {
    window.history.replaceState({}, "", `/collectibles/transfer?providerId=provider-a&collectibleId=collectible-a&recipientPublicKeyHex=${RECIPIENT.toUpperCase()}`);
    renderPage();
    const widget = await screen.findByTestId("widget");
    expect(widget.dataset.ref).toBe("provider-a/collectible-a");
    expect(widget.dataset.recipient).toBe(RECIPIENT);
  });

  it("shows recipient-specific empty state instead of mounting a handler that rejects the target", async () => {
    window.history.replaceState({}, "", `/collectibles/transfer?providerId=provider-a&collectibleId=collectible-a&recipientPublicKeyHex=${RECIPIENT}`);
    renderPage({ handlers: [handler("handler-a", 1, () => false)] });
    await waitFor(() => expect(screen.getByText("This collectible does not support transfer to a contact public key")).toBeTruthy());
    expect(screen.queryByTestId("widget")).toBeNull();
  });

  it("keeps the ordinary collectible transfer flow without a recipient target", async () => {
    window.history.replaceState({}, "", "/collectibles/transfer?providerId=provider-a&collectibleId=collectible-a");
    renderPage({ handlers: [handler("handler-a", 1, () => false)] });
    expect((await screen.findByTestId("widget")).dataset.recipient).toBe("");
  });

  it("does not load a provider for an invalid recipient target", async () => {
    const getCollectible = vi.fn(async () => DETAIL);
    window.history.replaceState({}, "", "/collectibles/transfer?providerId=provider-a&collectibleId=collectible-a&recipientPublicKeyHex=not-a-key");
    renderPage({ getCollectible });
    expect(screen.getByText("Invalid contact transfer target")).toBeTruthy();
    expect(getCollectible).not.toHaveBeenCalled();
  });

  it("continues to select the lowest-order matching handler", async () => {
    window.history.replaceState({}, "", "/collectibles/transfer?providerId=provider-a&collectibleId=collectible-a");
    renderPage({ handlers: [handler("later", 20), handler("first", 10)] });
    expect((await screen.findByTestId("widget")).textContent).toBe("first");
  });

  it("rejects conflicting matching handler order instead of selecting one silently", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.history.replaceState({}, "", "/collectibles/transfer?providerId=provider-a&collectibleId=collectible-a");
    renderPage({ handlers: [handler("first", 10), handler("second", 10)] });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Multiple collectible transfer handlers with the same order/);
    expect(screen.queryByTestId("widget")).toBeNull();
    consoleError.mockRestore();
  });
});
