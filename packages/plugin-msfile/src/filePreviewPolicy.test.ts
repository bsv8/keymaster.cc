// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createMsFileIsolatedHtmlBlobUrl,
  decodeMsFileUtf8,
  decideMsFileHomePreview,
  hasMsFilePreviewSignature,
  normalizeMsFileMediaType,
} from "./filePreviewPolicy.js";

describe("MSFile home preview policy", () => {
  it("normalizes MIME parameters without using the filename", () => {
    expect(normalizeMsFileMediaType(" Text/Plain; charset=utf-8 ")).toBe("text/plain");
    expect(decideMsFileHomePreview("text/plain; charset=utf-8", "1").canAutoPreview).toBe(true);
    expect(decideMsFileHomePreview("image/svg+xml", "1").canAutoPreview).toBe(false);
    expect(decideMsFileHomePreview("text/javascript", "1").canAutoPreview).toBe(false);
    expect(decideMsFileHomePreview("text/custom", "1").canAutoPreview).toBe(false);
  });

  it("uses inclusive 32 MiB preview and 256 MiB download boundaries", () => {
    expect(decideMsFileHomePreview("text/plain", String(32 * 1024 * 1024))).toMatchObject({
      canAutoPreview: true,
      canBlobDownload: true,
    });
    expect(decideMsFileHomePreview("text/plain", String(32 * 1024 * 1024 + 1))).toMatchObject({
      canAutoPreview: false,
      canBlobDownload: true,
      reason: "preview-size-limit",
    });
    expect(decideMsFileHomePreview("application/octet-stream", String(256 * 1024 * 1024))).toMatchObject({
      canAutoPreview: false,
      canBlobDownload: true,
    });
    expect(decideMsFileHomePreview("text/plain", String(256 * 1024 * 1024 + 1))).toMatchObject({
      canAutoPreview: false,
      canBlobDownload: false,
      reason: "preview-size-limit",
    });
    expect(decideMsFileHomePreview("text/plain", "01").reason).toBe("invalid-file-size");
  });

  it("requires known signatures for binary previews", () => {
    expect(hasMsFilePreviewSignature("image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(hasMsFilePreviewSignature("image/png", new Uint8Array([1, 2, 3]))).toBe(false);
    expect(hasMsFilePreviewSignature("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(hasMsFilePreviewSignature("image/svg+xml", new TextEncoder().encode("<svg>"))).toBe(false);
  });

  it("uses fatal UTF-8 decoding for text", () => {
    expect(decodeMsFileUtf8([new TextEncoder().encode("hello"), new TextEncoder().encode(" 世界")])).toBe("hello 世界");
    expect(decodeMsFileUtf8([new Uint8Array([0xc3, 0x28])])).toBeUndefined();
  });

  it("creates an opaque-origin HTML payload with restrictive CSP and no active sinks", async () => {
    let captured: Blob | undefined;
    const url = createMsFileIsolatedHtmlBlobUrl(
      "<!doctype html><html><head><meta http-equiv=refresh content=0;url=https://evil.test><script>parent.postMessage(1,'*')</script></head><body><a href=https://evil.test>go</a><form action=https://evil.test><input></form><img src=https://evil.test/x.png><p style='color:red'>safe</p></body></html>",
      (blob) => { captured = blob; return "blob:isolated-test"; },
    );
    expect(url).toBe("blob:isolated-test");
    const serialized = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(captured!);
    });
    expect(serialized).toContain("Content-Security-Policy");
    expect(serialized).toContain("default-src 'none'");
    expect(serialized).toContain("style-src 'unsafe-inline'");
    expect(serialized).not.toContain("<script");
    expect(serialized).not.toContain("<form");
    expect(serialized).not.toContain("<input");
    expect(serialized).not.toContain("https://evil.test");
    expect(serialized).not.toMatch(/<a[^>]+href=/i);
  });
});
