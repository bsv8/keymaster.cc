import type { SystemStatusModule } from "@keymaster/contracts";

export interface SystemStatusRegistry {
  register(module: SystemStatusModule): void;
  unregister(id: string): void;
  list(): SystemStatusModule[];
  _ids(): string[];
}

/** 系统状态模块钩子：仅承载常驻模块的实时状态视图。 */
export function createSystemStatusRegistry(): SystemStatusRegistry {
  const modules = new Map<string, SystemStatusModule>();

  function register(module: SystemStatusModule): void {
    if (modules.has(module.id)) {
      throw new Error(`System status module id "${module.id}" is already registered`);
    }
    modules.set(module.id, module);
  }

  function unregister(id: string): void {
    if (!modules.delete(id)) {
      throw new Error(`System status module id "${id}" is not registered`);
    }
  }

  return {
    register,
    unregister,
    list: () => [...modules.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    _ids: () => [...modules.keys()]
  };
}
