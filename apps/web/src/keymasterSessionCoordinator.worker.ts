import { startSharedWorkerApp } from "webloom-framework";
import { coordinatorHostOptions, attachCoordinatorHost } from "./assembly/coordinatorWorker.js";
import { installSharedWorkerRetirement } from "./coordinator/sharedWorkerRetirement.js";

// 单个 SharedWorker 装配所有插件单元；各插件拥有自己的 setup、状态与清理。
// Coordinator 提供跨 tab 会话与最终 I/O 栅栏，Webloom Host 执行声明的生命周期。
if ((globalThis as unknown as { onconnect?: unknown }).onconnect !== undefined) {
  const host = startSharedWorkerApp(coordinatorHostOptions());
  attachCoordinatorHost(host);
  installSharedWorkerRetirement(host, globalThis as unknown as Parameters<typeof installSharedWorkerRetirement>[1]);
}
