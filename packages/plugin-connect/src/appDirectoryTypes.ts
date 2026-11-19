import type { AppSourceEntry } from "@keymaster/contracts";
/** 已接受的单来源发布：整份保存，不拼接其他来源字段。 */
export interface AppAcceptedSource {
  sourceId: string;
  publication: AppSourceEntry;
  /** 持久化提交序号：同版本不同内容按实际提交顺序判定；同源重放不改变。 */
  sequence: number;
}
export interface AppDirectoryEntry extends AppSourceEntry {
  favorite: boolean;
  selected?: { url?: string; indexseedhashhex?: string };
  /** 当前展示资料的归属来源；无有效来源但被保留时为空。 */
  sourceId?: string;
}
export interface AppDirectoryDocument {
  version: 1;
  /** 当前展示目录：每个 App 一份完整发布 + 用户状态，不拼接来源字段。 */
  apps: Record<string, AppDirectoryEntry>;
  /** 每个 App 每个来源已接受的整份发布，供失效回退使用。 */
  sources: Record<string, Record<string, AppAcceptedSource>>;
  /** 按公钥持久保存的收藏；历史 App 无目录条目时仍保留。 */
  favorites: string[];
  /** 用户手动删除的保留标记；自动同步重放不得清除。 */
  deletedKeys: string[];
  /** 目录级单调提交序号；仅成功提交时推进，同版本按其判定先后。 */
  sequence: number;
}
/** Internal repository: deleting management material and the directory is one policy CAS. */
export interface AppDirectoryRepository {
  read(): Promise<{ document: AppDirectoryDocument; revision: number } | null>;
  write(document: AppDirectoryDocument, options: { ifRevision?: number; forgetKey?: string }): Promise<number>;
}
