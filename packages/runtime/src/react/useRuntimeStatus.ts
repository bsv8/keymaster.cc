// packages/runtime/src/react/useRuntimeStatus.ts
// 暴露 vault.status 和 bootstrap 状态。
// 设计缘由：App 组件需要根据 booting / locked / unlocked 决定渲染哪个 shell。

import { useEffect, useState } from "react";
import { useCapability } from "./useCapability.js";
import type { VaultService, VaultStatus } from "@keymaster/contracts";

export interface RuntimeStatus {
  vault: VaultStatus;
  /** 平台 capability 是否就绪。 */
  ready: boolean;
}

export function useRuntimeStatus(): RuntimeStatus {
  const vault = useCapability<VaultService | undefined>("vault.service");
  const [status, setStatus] = useState<VaultStatus>("booting");

  useEffect(() => {
    if (!vault) {
      setStatus("booting");
      return;
    }
    setStatus(vault.status());
    return vault.onStatusChange(setStatus);
  }, [vault]);

  return {
    vault: status,
    ready: !!vault
  };
}
