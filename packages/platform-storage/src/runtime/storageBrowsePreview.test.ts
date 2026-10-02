// 预览格式判定与路径边界的纯逻辑测试。
//
// 这些判定同时决定「Worker 返回什么」和「页面怎么画」，因此单独验证：
//   P01/P02 JSON、无扩展名 JSON、损坏 JSON、空文件、非法 UTF-8
//   P03 Markdown 与 TXT 的格式判定
//   P05 K-V 信封、版本、哈希与二进制载荷
//   P06 截断内容一律不做结构化解析
//   A02 路径规范化与目录前缀拼装

import { describe, expect, it } from "vitest";
import { kvEncodeValue, kvEncodeValueObject } from "../kv-engine/kvValueCodec.js";
import {
  BrowsePathError,
  directoryScanPrefix,
  normalizeBrowseDirectory,
  normalizeBrowseObjectPath,
} from "./storageBrowsePaths.js";
import { detectBrowsePreview } from "./storageBrowsePreview.js";

const ENCODER = new TextEncoder();

function detect(input: { path: string; value?: string | Uint8Array; contentType?: string; truncated?: boolean }) {
  const bytes = typeof input.value === "string" ? ENCODER.encode(input.value) : input.value ?? new Uint8Array(0);
  return detectBrowsePreview({
    path: input.path,
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
    bytes,
    truncated: input.truncated ?? false,
  });
}

function kvValueObject(value: unknown, valueId: string): Uint8Array {
  const encoded = kvEncodeValue(value);
  return kvEncodeValueObject(valueId, "default", encoded, 1_700_000_000_000);
}

describe("detectBrowsePreview format routing (P01/P02/P03)", () => {
  it("recognizes JSON by extension, content type and well-known names", () => {
    expect(detect({ path: "a.json", value: '{"a":1}' }).format).toBe("json");
    expect(detect({ path: "a.json", value: '{"a":1}', contentType: "application/json" }).format).toBe("json");
    expect(detect({ path: "a.txt", value: '{"a":1}', contentType: "application/json" }).format).toBe("json");
    // 无扩展名也无内容类型：current / meta 这类确实写成 JSON 的名字照样识别。
    expect(detect({ path: "bsv-price/.keymaster/values/current", value: '{"v":1}' }).format).toBe("json");
    expect(detect({ path: "bsv-price/.keymaster/values/meta", value: "[1,2]" }).format).toBe("json");
    // 无扩展名且名字陌生：靠内容检测，仍能认出确凿的 JSON。
    expect(detect({ path: "weird-name", value: '{"a":1}' }).format).toBe("json");
  });

  it("keeps broken JSON visible instead of showing an empty object (P02)", () => {
    const broken = detect({ path: "a.json", value: '{"a":' });
    expect(broken.format).toBe("json-broken");
    expect(broken.text).toBe('{"a":');
    // 声称是 JSON 却根本不是 JSON（纯文本内容）时，展示原文与失败提示：改判成
    // 二进制会让用户完全看不到文件内容。
    const text = detect({ path: "a.json", value: "not JSON" });
    expect(text.format).toBe("json-broken");
    expect(text.text).toBe("not JSON");
    // 只有连文本都不是（非法 UTF-8）时才说「不支持预览」。
    expect(detect({ path: "a.json", value: new Uint8Array([0xff, 0xfe, 0x00]) }).format).toBe("binary");
  });

  it("accepts every top-level JSON value, not only objects and arrays (P01)", () => {
    // JSON 文法包含顶层标量；把它们判成二进制是错误约束而不是安全策略。
    for (const value of ["123", "-1.5e10", "true", "false", "null", '"hello"', "{}", "[]"]) {
      const result = detect({ path: "a.json", value });
      expect(result.format, value).toBe("json");
      expect(result.text, value).toBe(value);
    }
    // 内容类型声明为 JSON 的无扩展名文件同样按完整语法解析。
    expect(detect({ path: "notes", value: "42", contentType: "application/json" }).format).toBe("json");
    expect(detect({ path: "notes", value: "null", contentType: "application/vnd.thing+json" }).format).toBe("json");
    // 既无声明也无扩展名时，顶层标量仍不足以断定它是 JSON。
    expect(detect({ path: "notes", value: "123" }).format).toBe("binary");
  });

  it("reports empty files before anything else", () => {
    expect(detect({ path: "empty.json", value: "" }).format).toBe("empty");
    expect(detect({ path: "empty.md", value: "" }).format).toBe("empty");
    expect(detect({ path: "empty.unknown", value: "" }).format).toBe("empty");
  });

  it("treats invalid UTF-8 as unsupported rather than silently replacing bytes (P02)", () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" 的 Latin-1 编码
    expect(detect({ path: "a.json", value: latin1 }).format).toBe("binary");
    expect(detect({ path: "a.txt", value: latin1 }).format).toBe("binary");
    expect(detect({ path: "a.md", value: latin1 }).format).toBe("binary");
  });

  it("accepts a UTF-8 BOM instead of mistaking it for broken JSON", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...ENCODER.encode('{"a":1}')]);
    const result = detect({ path: "a.json", value: withBom });
    expect(result.format).toBe("json");
    expect(result.text).toBe('{"a":1}');
  });

  it("routes Markdown and text by extension and content type (P03)", () => {
    expect(detect({ path: "readme.md", value: "# Title" }).format).toBe("markdown");
    expect(detect({ path: "readme.markdown", value: "# Title" }).format).toBe("markdown");
    expect(detect({ path: "notes", value: "# Title", contentType: "text/markdown; charset=utf-8" }).format).toBe("markdown");
    expect(detect({ path: "notes.txt", value: "hello" }).format).toBe("text");
    expect(detect({ path: "notes", value: "hello", contentType: "text/plain" }).format).toBe("text");
    expect(detect({ path: "weird", value: "hello" }).format).toBe("binary");
  });

  it("lets a declared binary content type win over a text extension", () => {
    expect(detect({ path: "cover.txt", value: "hello", contentType: "image/png" }).format).toBe("binary");
    expect(detect({ path: "cover.txt", value: "hello", contentType: "application/octet-stream" }).format).toBe("binary");
  });
});

describe("detectBrowsePreview truncation (P06)", () => {
  it("never parses truncated content structurally", () => {
    expect(detect({ path: "a.json", value: '{"a":1}', truncated: true }).format).toBe("truncated");
    expect(detect({ path: "a.md", value: "# Title", truncated: true }).format).toBe("truncated");
    expect(detect({ path: "a.txt", value: "hello", truncated: true }).format).toBe("truncated");
    expect(detect({ path: "a.bin", value: new Uint8Array([1, 2, 3]), truncated: true }).format).toBe("truncated");
    // 截断内容不携带任何解码结论。
    expect(detect({ path: "a.json", value: '{"a":1}', truncated: true }).text).toBeUndefined();
  });

  it("does not claim a K-V decode for a truncated envelope", () => {
    const full = kvValueObject({ note: "hi" }, "value-1");
    const truncated = detect({ path: "v.bin", value: full.subarray(0, 40), truncated: true });
    expect(truncated.format).toBe("truncated");
    expect(truncated.kvPayload).toBeUndefined();
    expect(truncated.kvError).toBeUndefined();
  });
});

describe("detectBrowsePreview K-V envelopes (P05)", () => {
  it("decodes a valid JSON payload and reports its envelope header", () => {
    const result = detect({ path: ".keymaster/values/value-1", value: kvValueObject({ note: "hi" }, "value-1") });
    expect(result.format).toBe("kv-value");
    expect(result.kvPayload).toMatchObject({ valueId: "value-1", partition: "default", json: true });
    expect(result.kvPayload?.jsonText).toBe('{"note":"hi"}');
    expect(result.kvPayload?.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("keeps attributes but refuses a text preview for a binary payload", () => {
    const result = detect({ path: ".keymaster/values/blob", value: kvValueObject(new Uint8Array([1, 2, 3]), "blob") });
    expect(result.format).toBe("kv-invalid");
    expect(result.kvError).toBe("payload-unsupported");
    // 信封与哈希都已通过校验，因此属性仍然可用。
    expect(result.kvPayload).toMatchObject({ valueId: "blob", json: false });
    expect(result.kvPayload?.jsonText).toBeUndefined();
  });

  it("reports a payload hash mismatch without pretending to decode (P05)", () => {
    const object = kvValueObject({ note: "hi" }, "value-1");
    const tampered = new Uint8Array(object);
    // noUncheckedIndexedAccess：末字节显式取出来再翻转，篡改位置在测试里是确定的。
    const last = tampered.byteLength - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    const result = detect({ path: ".keymaster/values/value-1", value: tampered });
    expect(result.format).toBe("kv-invalid");
    expect(result.kvError).toBe("hash-mismatch");
    expect(result.kvPayload).toBeUndefined();
  });

  it("rejects a malformed envelope and an unsupported version (P05)", () => {
    const malformed = new TextEncoder().encode("keymaster-kv-value-v1:{not json\n{}");
    expect(detect({ path: ".keymaster/values/x", value: malformed })).toMatchObject({ format: "kv-invalid", kvError: "envelope-invalid" });

    const encoded = kvEncodeValue({ note: "hi" });
    const header = new TextEncoder().encode(
      "keymaster-kv-value-v1:" + JSON.stringify({
        format: "keymaster.kv-value",
        version: 99,
        valueId: "value-1",
        partition: "default",
        valueHash: encoded.valueHash,
        createdAt: 1,
      }) + "\n",
    );
    const future = new Uint8Array(header.byteLength + encoded.bytes.byteLength);
    future.set(header, 0);
    future.set(encoded.bytes, header.byteLength);
    expect(detect({ path: ".keymaster/values/value-1", value: future })).toMatchObject({
      format: "kv-invalid",
      kvError: "version-unsupported",
    });
  });
});

describe("browse path normalization (A02)", () => {
  it("maps the display root and trailing-slash prefixes to the logical root", () => {
    expect(normalizeBrowseDirectory("")).toBe("");
    expect(normalizeBrowseDirectory("/")).toBe("");
    expect(normalizeBrowseDirectory("apps/a")).toBe("apps/a");
    expect(normalizeBrowseDirectory("apps/a/")).toBe("apps/a");
  });

  it("refuses absolute paths, traversal and empty segments", () => {
    for (const prefix of ["/apps", "../apps", "apps/../../etc", "apps/./x", "apps//x", "\\\\server\\share"]) {
      expect(() => normalizeBrowseDirectory(prefix), prefix).toThrow(BrowsePathError);
    }
    for (const path of ["", "/", "/notes/a.txt", "../secrets", "notes/../..", "notes//a.txt"]) {
      expect(() => normalizeBrowseObjectPath(path), path).toThrow(BrowsePathError);
    }
  });

  it("adds a trailing slash so a directory prefix cannot match a sibling name", () => {
    expect(directoryScanPrefix("")).toBeUndefined();
    expect(directoryScanPrefix("apps/a")).toBe("apps/a/");
    // "apps/a" 不加斜杠会命中 "apps/a-evil/…"；这就是必须补斜杠的理由。
    expect("apps/a-evil/secret.json".startsWith("apps/a")).toBe(true);
    expect("apps/a-evil/secret.json".startsWith("apps/a/")).toBe(false);
  });
});
