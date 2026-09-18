// 真实 Go msfile-nas 页面 Journey 使用的确定性文件夹具。
//
// 夹具内容完全由本文件决定，不读取仓库外数据：文本文件用于证明首页
// 预览内容与 NAS 源文件一致；二进制文件跨 Block，用于证明下载结果与
// NAS 源文件 SHA-256、长度都一致。

import type { MsFileNasFixtureFile } from "../resources/msfile/localNasResource.js";

export const MSFILE_NAS_TEXT_FILENAME = "keymaster-nas-journey-note.txt";
export const MSFILE_NAS_BINARY_FILENAME = "keymaster-nas-journey-payload.bin";

/** 只用于 absent 断言；格式合法但 NAS 索引里不存在。 */
export const MSFILE_NAS_ABSENT_SEED_HASH = "0".repeat(64);

/** 多行 UTF-8 文本；首页 `<pre>` 必须原样展示。 */
export const MSFILE_NAS_TEXT_CONTENT = [
  "Keymaster MSFile real NAS journey fixture",
  "seed-hash lookup -> supplier stat -> seed plan -> verified blocks -> preview",
  "内容必须与 NAS 磁盘上的源文件逐字节一致。",
  "",
].join("\n");

/** 跨 3 个 Block 的确定性二进制内容；不能用整段填充冒充跨块。 */
function binaryBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let offset = 0; offset < bytes.length; offset += 1) {
    bytes[offset] = (offset * 31 + 7) % 251;
  }
  return bytes;
}

/** 655 359 字节：seed plan 需要 3 个 Block，覆盖多块读取与装配。 */
const MSFILE_NAS_BINARY_BYTES = binaryBytes(655_359);

export function msfileNasJourneyFixtures(): readonly MsFileNasFixtureFile[] {
  return [
    {
      filename: MSFILE_NAS_TEXT_FILENAME,
      mediaType: "text/plain",
      bytes: new TextEncoder().encode(MSFILE_NAS_TEXT_CONTENT),
    },
    {
      filename: MSFILE_NAS_BINARY_FILENAME,
      mediaType: "application/octet-stream",
      bytes: MSFILE_NAS_BINARY_BYTES,
    },
  ];
}
