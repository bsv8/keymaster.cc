import type { VaultService } from "@keymaster/contracts";
import type { InternalVaultService } from "./internalVaultService.js";
/** 显式白名单对象，不能通过原型或字段访问内部管理服务。 */
export function createPublicVaultService(service: InternalVaultService): VaultService {
  return Object.freeze(Object.assign(Object.create(null), {
    status: service.status.bind(service),
    getCurrentKey: service.getCurrentKey.bind(service),
    hasVault: service.hasVault.bind(service),
    unlock: service.unlock.bind(service),
    lock: service.lock.bind(service),
    verifyPassword: service.verifyPassword.bind(service),
    createActiveKeyCrypto: service.createActiveKeyCrypto.bind(service),
    createAppViewSession: service.createAppViewSession.bind(service),
    disposeAppViewSession: service.disposeAppViewSession.bind(service),
    disposeAllAppViewSessions: service.disposeAllAppViewSessions.bind(service)
  })) as VaultService;
}
