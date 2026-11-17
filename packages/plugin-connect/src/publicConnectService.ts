import type { ConnectService } from "@keymaster/contracts";
/** Only contract methods cross the capability boundary; implementation references stay private. */
export function createPublicConnectService(service: ConnectService, assertActive: () => void): ConnectService {
  function call<T>(execute: () => T): T {
    assertActive();
    const result = execute();
    if (result instanceof Promise) return result.then(value => { assertActive(); return value; }) as T;
    assertActive();
    return result;
  }
  return Object.freeze(Object.assign(Object.create(null), {
    startSession: (...args: Parameters<ConnectService["startSession"]>) => call(() => service.startSession(...args)),
    endSession: (...args: Parameters<ConnectService["endSession"]>) => call(() => service.endSession(...args)),
    handleMessage: (...args: Parameters<ConnectService["handleMessage"]>) => call(() => service.handleMessage(...args)),
    confirmByUser: (...args: Parameters<ConnectService["confirmByUser"]>) => call(() => service.confirmByUser(...args)),
    rejectByUser: (...args: Parameters<ConnectService["rejectByUser"]>) => call(() => service.rejectByUser(...args)),
    resumeAfterUnlock: (...args: Parameters<ConnectService["resumeAfterUnlock"]>) => call(() => service.resumeAfterUnlock(...args)),
    ...(service.pageUnloading ? { pageUnloading: (...args: Parameters<NonNullable<ConnectService["pageUnloading"]>>) => call(() => service.pageUnloading!(...args)) } : {}),
    currentRequest: (...args: Parameters<ConnectService["currentRequest"]>) => call(() => service.currentRequest(...args)),
    currentRequestAutoApproved: (...args: Parameters<ConnectService["currentRequestAutoApproved"]>) => call(() => service.currentRequestAutoApproved(...args)),
    subscribe: (...args: Parameters<ConnectService["subscribe"]>) => call(() => service.subscribe(...args)),
    snapshot: (...args: Parameters<ConnectService["snapshot"]>) => call(() => service.snapshot(...args)),
    currentOrigin: (...args: Parameters<ConnectService["currentOrigin"]>) => call(() => service.currentOrigin(...args)),
    feedSnapshot: (...args: Parameters<ConnectService["feedSnapshot"]>) => call(() => service.feedSnapshot(...args)),
    subscribeFeed: (...args: Parameters<ConnectService["subscribeFeed"]>) => call(() => service.subscribeFeed(...args)),
    getOriginSettings: (...args: Parameters<ConnectService["getOriginSettings"]>) => call(() => service.getOriginSettings(...args)),
    setOriginSettings: (...args: Parameters<ConnectService["setOriginSettings"]>) => call(() => service.setOriginSettings(...args)),
    confirmDeadlineMs: (...args: Parameters<ConnectService["confirmDeadlineMs"]>) => call(() => service.confirmDeadlineMs(...args)),
    lockState: (...args: Parameters<ConnectService["lockState"]>) => call(() => service.lockState(...args)),
    connectAuthSnapshot: (...args: Parameters<ConnectService["connectAuthSnapshot"]>) => call(() => service.connectAuthSnapshot(...args)),
    lockSummarySnapshot: (...args: Parameters<ConnectService["lockSummarySnapshot"]>) => call(() => service.lockSummarySnapshot(...args)),
    syncWalletState: (...args: Parameters<ConnectService["syncWalletState"]>) => call(() => service.syncWalletState(...args)),
    launchAppView: (...args: Parameters<ConnectService["launchAppView"]>) => call(() => service.launchAppView(...args)),
    connectLoginRecord: (...args: Parameters<ConnectService["connectLoginRecord"]>) => call(() => service.connectLoginRecord(...args)),
    confirmConnectLogin: (...args: Parameters<ConnectService["confirmConnectLogin"]>) => call(() => service.confirmConnectLogin(...args)),
    rejectConnectRequest: (...args: Parameters<ConnectService["rejectConnectRequest"]>) => call(() => service.rejectConnectRequest(...args)),
  } satisfies ConnectService));
}
