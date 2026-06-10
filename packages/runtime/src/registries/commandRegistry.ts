// packages/runtime/src/registries/commandRegistry.ts
// 命令注册表：菜单、Topbar、快捷键都通过 command 调用。
// 设计缘由：把"动作"从"展示"中抽离，命令可以在多个入口复用。

import type { I18nText } from "@keymaster/contracts";

export interface Command {
  /** 命令 id，使用命名空间。 */
  id: string;
  /** 展示名。硬切换后为 I18nText。 */
  label: I18nText;
  /** 描述。硬切换后为 I18nText。 */
  description?: I18nText;
  /** 执行命令。 */
  run(): void | Promise<void>;
  /** 是否在当前状态下可用。 */
  enabled?(ctx: { unlocked: boolean }): boolean;
}

export interface CommandRegistry {
  register(command: Command): void;
  list(): Command[];
  get(id: string): Command | undefined;
  /** 执行命令；未注册抛错。 */
  run(id: string): Promise<void>;
}

export function createCommandRegistry(): CommandRegistry {
  const map = new Map<string, Command>();

  return {
    register(command) {
      if (map.has(command.id)) {
        throw new Error(`Command id "${command.id}" is already registered`);
      }
      map.set(command.id, command);
    },
    list() {
      return [...map.values()];
    },
    get(id) {
      return map.get(id);
    },
    async run(id) {
      const cmd = map.get(id);
      if (!cmd) throw new Error(`Command "${id}" is not registered`);
      await cmd.run();
    }
  };
}
