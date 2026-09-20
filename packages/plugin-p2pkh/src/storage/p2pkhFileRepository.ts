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
  parseP2pkhSettingFile,
  p2pkhHistoryPath,
  resolveP2pkhSetting,
  serializeP2pkhHistoryFile,
  serializeP2pkhSettingFile,
  type P2pkhFileNetwork,
  type P2pkhHistoryEntryV1,
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

  return {
    getStore(): BorrowedOwnerFileStore { return files; },
    readSetting,
    writeSetting,
    readHistory,
    writeHistory,
  };
}

export type P2pkhFileRepositoryHandle = ReturnType<typeof createP2pkhFileRepository>;
