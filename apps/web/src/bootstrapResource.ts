import { APPLICATION_BOOTSTRAP_RESOURCE_ID, type ApplicationBootstrapSnapshot, type ApplicationBootstrapStatus, type ResourceRegistry } from "@keymaster/contracts";
export function registerApplicationBootstrapResource(registry: ResourceRegistry, applicationBootstrap: ApplicationBootstrapStatus): void {
  if (applicationBootstrap) {
    registry.register<ApplicationBootstrapSnapshot, readonly string[]>({
      id: APPLICATION_BOOTSTRAP_RESOURCE_ID,
      scope: "global",
      key: () => [APPLICATION_BOOTSTRAP_RESOURCE_ID],
      load: async () => applicationBootstrap.snapshot(),
      // ResourceDefinition 的 subscribe 只表达“资源已失效”；状态读取仍由
      // load 完成，避免 React 组件直接订阅业务 service。
      subscribe: (_args, _context, invalidate) => applicationBootstrap.subscribe(() => invalidate()),
      equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
      invalidation: "immediate"
    });
  }
}
