import type { PlatformRootStore } from "@keymaster/contracts";

// @ts-expect-error Storage 的内部浏览服务不能从公开领域契约导入。
import type { StorageBrowseService } from "@keymaster/contracts";
// @ts-expect-error 公共根存储契约不提供全钱包浏览入口。
type PublicBrowse = PlatformRootStore["openBrowseStore"];

// 保留类型引用，让编译期负面检查随本包一起执行；无运行时代码。
// @ts-expect-error 私有浏览命令已经从公共 Coordinator 联合删除。
const publicBrowseCommand: import("@keymaster/contracts").CoordinatorRpcRequest["kind"] = "storage.browse.open";
// @ts-expect-error 浏览会话 DTO 也只留在 Storage 包内。
import type { StorageBrowseSession } from "@keymaster/contracts";
export type StoragePrivateBoundaryChecks = [StorageBrowseService, PublicBrowse, typeof publicBrowseCommand, StorageBrowseSession];
