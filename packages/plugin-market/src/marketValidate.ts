import { decodeDirectory } from "keymaster-market-protocol";
import { verifyFilesPublication, verifyUrlPublication } from "./marketVerify.js";
import type { AppSourceEntry } from "@keymaster/contracts";

function canonicalOrigin(input: string): string {
  const u = new URL(input);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.origin === "null") throw new Error("Invalid App URL");
  return u.origin;
}

/**
 * KeymasterMarketProtocol v1 目录解码：经协议库逐渠道验签（注入本插件的
 * 发布证明验证器）、双渠道公钥与版本一致性检查与按公钥去重，转换为
 * Connect 目录条目。任一条目无效使整份响应无效；`{"apps":[]}` 合法空。
 */
export function decodeProtocolDirectory(raw: string): AppSourceEntry[] {
  const apps = decodeDirectory(raw, verifyUrlPublication, verifyFilesPublication);
  return apps.map(app => {
    const entry: AppSourceEntry = {
      appVersion: app.appVersion,
      appPublicKeyHex: app.appPublicKeyHex,
      urls: [], files: [],
    };
    if (app.name) entry.name = app.name;
    if (app.description) entry.description = app.description;
    if (app.iconUrl) entry.icon = app.iconUrl;
    if (app.url) {
      entry.urls.push({ url: app.url.address, origin: canonicalOrigin(app.url.address), display: { name: app.url.name, description: app.url.description, icon: app.url.iconUrl } });
    }
    if (app.files) {
      entry.files.push({ indexseedhashhex: app.files.indexseedhashhex, display: { name: app.files.name, description: app.files.description, icon: app.files.iconUrl } });
    }
    return entry;
  });
}

/** 整份发布内容比较键（同版本比较整份内容，不只比较 appVersion）。 */
export function marketContentKey(value: AppSourceEntry): string {
  const norm = {
    appVersion: value.appVersion, appPublicKeyHex: value.appPublicKeyHex.toLowerCase(),
    name: value.name, description: value.description, icon: value.icon,
    urls: (value.urls ?? []).map(u => ({ url: u.url, origin: u.origin, display: u.display })),
    files: (value.files ?? []).map(f => ({ indexseedhashhex: f.indexseedhashhex, display: f.display })),
  };
  return JSON.stringify(norm);
}
