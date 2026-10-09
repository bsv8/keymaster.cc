// P2PKH 桶内文件仓储：setting.json + <net>/history.json。
//
// 真值规则（2026-09-20 解耦）：
//   - raw tx / UTXO / 花费关系不再落盘，也不再有 tx/height 目录；
//   - 历史文件只保存 WoC history 的 txid/height/fee 元数据；
//   - 完整分页成功后才整文件替换；读取失败按“历史不可用”处理，不清空
//     调用方已持有的数据；
//   - 损坏文件跳过并记录，不影响其它文件。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import {
  P2PKH_SETTING_FILE_NAME,
  parseP2pkhHistoryFile,
  parseP2pkhProtocolFundingFile,
  p2pkhProtocolFundingPath,
  parseP2pkhSettingFile,
  p2pkhHistoryPath,
  resolveP2pkhSetting,
  serializeP2pkhHistoryFile,
  serializeP2pkhProtocolFundingFile,
  serializeP2pkhSettingFile,
  type P2pkhFileNetwork,
  type P2pkhHistoryEntryV1,
  type P2pkhProtocolFundingEntryV1,
  type P2pkhResolvedSetting,
} from "./p2pkhFileFormats.js";

const NETWORKS: readonly P2pkhFileNetwork[] = ["main", "test"];

function assertNetwork(network: P2pkhFileNetwork): P2pkhFileNetwork {
  if (!NETWORKS.includes(network)) throw new Error("P2PKH network is invalid");
  return network;
}

/** Repository 只接收 Host 已绑定的 `p2pkh/` owner 文件根。 */
export function createP2pkhFileRepository(files: BorrowedOwnerFileStore) {
  async function readSetting(): Promise<P2pkhResolvedSetting> {
    const object = await files.get(P2PKH_SETTING_FILE_NAME);
    if (!object) return resolveP2pkhSetting();
    const parsed = parseP2pkhSettingFile(object.bytes);
    // 设置文件损坏时按“文件不存在 = 全部默认”处理，不阻塞钱包。
    return resolveP2pkhSetting(parsed);
  }

  async function writeSetting(setting: P2pkhResolvedSetting): Promise<void> {
    await files.put(P2PKH_SETTING_FILE_NAME, serializeP2pkhSettingFile(setting));
  }

  /** 读取一个网络的历史元数据；文件不存在或损坏返回 undefined。 */
  async function readHistory(networkInput: P2pkhFileNetwork): Promise<P2pkhHistoryEntryV1[] | undefined> {
    const network = assertNetwork(networkInput);
    const object = await files.get(p2pkhHistoryPath(network));
    if (!object) return undefined;
    return parseP2pkhHistoryFile(object.bytes);
  }

  /** 整文件替换一个网络的历史元数据。 */
  async function writeHistory(networkInput: P2pkhFileNetwork, records: readonly P2pkhHistoryEntryV1[]): Promise<void> {
    const network = assertNetwork(networkInput);
    await files.put(p2pkhHistoryPath(network), serializeP2pkhHistoryFile(records));
  }

  /**
   * 读一条专用资金记录；不存在返回 undefined，**损坏也返回 undefined**。
   *
   * 调用方必须区分「没有记录」与「记录读不出来」：前者可以重新准备，后者说明磁盘上
   * 有证据但不可用，直接重新拆钱会与原提交冲突。
   */
  async function readProtocolFunding(fundingId: string): Promise<P2pkhProtocolFundingEntryV1 | undefined> {
    const object = await files.get(p2pkhProtocolFundingPath(fundingId));
    if (!object) return undefined;
    return parseP2pkhProtocolFundingFile(object.bytes)?.record;
  }

  /**
   * 读**全部**专用资金记录，用于启动时恢复保护登记。
   *
   * 返回 `{ records, unreadable }`：`unreadable` 非空说明有文件损坏或 id 不安全，
   * 上层据此拒绝准备新资金，而不是当作「没有历史资金」。
   */
  async function listProtocolFunding(): Promise<{
    records: readonly P2pkhProtocolFundingEntryV1[];
    readonly unreadable: readonly string[];
  }> {
    const records: P2pkhProtocolFundingEntryV1[] = [];
    const unreadable: string[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await files.list({ prefix: "funding/", ...(cursor ? { cursor } : {}) });
      for (const file of page.files) {
        const fundingId = /^funding\/(.+)\.json$/u.exec(file.path)?.[1];
        if (fundingId === undefined) continue;
        const parsed = await readProtocolFunding(fundingId);
        if (parsed === undefined) {
          // 记录存在但读不出来：必须被上层看见，不能静默当成没有记录。
          unreadable.push(fundingId);
          continue;
        }
        records.push(parsed);
      }
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error("Protocol funding pagination did not advance");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return { records, unreadable };
  }

  /**
   * 写一条专用资金记录。
   *
   * 每条记录一个文件，因此两个标签页处理不同任务时写的是不同文件：一个页面的
   * 读-改-写不会覆盖另一个页面的写前日志。需要「仅当不存在时创建」时传
   * `ifNoneMatch`，用于创建竞态。
   */
  async function writeProtocolFunding(
    entry: P2pkhProtocolFundingEntryV1,
    options?: { ifAbsent?: true },
  ): Promise<void> {
    await files.put(
      p2pkhProtocolFundingPath(entry.fundingId),
      serializeP2pkhProtocolFundingFile(entry),
      { contentType: "application/json", ...(options?.ifAbsent === true ? { ifNoneMatch: true as const } : {}) },
    );
  }

  async function deleteProtocolFunding(fundingId: string): Promise<void> {
    await files.delete(p2pkhProtocolFundingPath(fundingId));
  }

  return {
    getStore(): BorrowedOwnerFileStore { return files; },
    readSetting,
    writeSetting,
    readHistory,
    writeHistory,
    readProtocolFunding,
    listProtocolFunding,
    writeProtocolFunding,
    deleteProtocolFunding,
  };
}

export type P2pkhFileRepositoryHandle = ReturnType<typeof createP2pkhFileRepository>;
