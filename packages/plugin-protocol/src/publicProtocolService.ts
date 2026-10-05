import type { ProtocolService } from "@keymaster/contracts";
/** Only contract methods cross the capability boundary; implementation references stay private. */
export function createPublicProtocolService(service: ProtocolService, assertActive: () => void): ProtocolService {
  function call<T>(execute: () => T): T {
    assertActive();
    const result = execute();
    if (result instanceof Promise) return result.then(value => { assertActive(); return value; }) as T;
    assertActive();
    return result;
  }
  return Object.freeze(Object.assign(Object.create(null), {
    startSession: (...args: Parameters<ProtocolService["startSession"]>) => call(() => service.startSession(...args)),
    endSession: (...args: Parameters<ProtocolService["endSession"]>) => call(() => service.endSession(...args)),
    handleMessage: (...args: Parameters<ProtocolService["handleMessage"]>) => call(() => service.handleMessage(...args)),
    confirmByUser: (...args: Parameters<ProtocolService["confirmByUser"]>) => call(() => service.confirmByUser(...args)),
    rejectByUser: (...args: Parameters<ProtocolService["rejectByUser"]>) => call(() => service.rejectByUser(...args)),
    resumeAfterUnlock: (...args: Parameters<ProtocolService["resumeAfterUnlock"]>) => call(() => service.resumeAfterUnlock(...args)),
    ...(service.pageUnloading ? { pageUnloading: (...args: Parameters<NonNullable<ProtocolService["pageUnloading"]>>) => call(() => service.pageUnloading!(...args)) } : {}),
    currentRequest: (...args: Parameters<ProtocolService["currentRequest"]>) => call(() => service.currentRequest(...args)),
    currentRequestAutoApproved: (...args: Parameters<ProtocolService["currentRequestAutoApproved"]>) => call(() => service.currentRequestAutoApproved(...args)),
    subscribe: (...args: Parameters<ProtocolService["subscribe"]>) => call(() => service.subscribe(...args)),
    snapshot: (...args: Parameters<ProtocolService["snapshot"]>) => call(() => service.snapshot(...args)),
    currentOrigin: (...args: Parameters<ProtocolService["currentOrigin"]>) => call(() => service.currentOrigin(...args)),
    feedSnapshot: (...args: Parameters<ProtocolService["feedSnapshot"]>) => call(() => service.feedSnapshot(...args)),
    subscribeFeed: (...args: Parameters<ProtocolService["subscribeFeed"]>) => call(() => service.subscribeFeed(...args)),
    getOriginSettings: (...args: Parameters<ProtocolService["getOriginSettings"]>) => call(() => service.getOriginSettings(...args)),
    setOriginSettings: (...args: Parameters<ProtocolService["setOriginSettings"]>) => call(() => service.setOriginSettings(...args)),
    confirmDeadlineMs: (...args: Parameters<ProtocolService["confirmDeadlineMs"]>) => call(() => service.confirmDeadlineMs(...args)),
    lockState: (...args: Parameters<ProtocolService["lockState"]>) => call(() => service.lockState(...args)),
    connectAuthSnapshot: (...args: Parameters<ProtocolService["connectAuthSnapshot"]>) => call(() => service.connectAuthSnapshot(...args)),
    lockSummarySnapshot: (...args: Parameters<ProtocolService["lockSummarySnapshot"]>) => call(() => service.lockSummarySnapshot(...args)),
    getVaultService: (...args: Parameters<ProtocolService["getVaultService"]>) => call(() => service.getVaultService(...args)),
    setVaultLockState: (...args: Parameters<ProtocolService["setVaultLockState"]>) => call(() => service.setVaultLockState(...args)),
    bootMode: (...args: Parameters<ProtocolService["bootMode"]>) => call(() => service.bootMode(...args)),
    appViewContext: (...args: Parameters<ProtocolService["appViewContext"]>) => call(() => service.appViewContext(...args)),
    bootstrapFailed: (...args: Parameters<ProtocolService["bootstrapFailed"]>) => call(() => service.bootstrapFailed(...args)),
    bootstrapFailureReason: (...args: Parameters<ProtocolService["bootstrapFailureReason"]>) => call(() => service.bootstrapFailureReason(...args)),
    appClientConnectTimedOut: (...args: Parameters<ProtocolService["appClientConnectTimedOut"]>) => call(() => service.appClientConnectTimedOut(...args)),
    appClientWaitingForReady: (...args: Parameters<ProtocolService["appClientWaitingForReady"]>) => call(() => service.appClientWaitingForReady(...args)),
    childReady: (...args: Parameters<ProtocolService["childReady"]>) => call(() => service.childReady(...args)),
    awaitLauncherBootstrap: (...args: Parameters<ProtocolService["awaitLauncherBootstrap"]>) => call(() => service.awaitLauncherBootstrap(...args)),
    openClientApp: (...args: Parameters<ProtocolService["openClientApp"]>) => call(() => service.openClientApp(...args)),
    launchAppView: (...args: Parameters<ProtocolService["launchAppView"]>) => call(() => service.launchAppView(...args)),
    connectLoginRecord: (...args: Parameters<ProtocolService["connectLoginRecord"]>) => call(() => service.connectLoginRecord(...args)),
    connectResumeRecord: (...args: Parameters<ProtocolService["connectResumeRecord"]>) => call(() => service.connectResumeRecord(...args)),
    confirmConnectLogin: (...args: Parameters<ProtocolService["confirmConnectLogin"]>) => call(() => service.confirmConnectLogin(...args)),
    confirmConnectResume: (...args: Parameters<ProtocolService["confirmConnectResume"]>) => call(() => service.confirmConnectResume(...args)),
    rejectConnectRequest: (...args: Parameters<ProtocolService["rejectConnectRequest"]>) => call(() => service.rejectConnectRequest(...args)),
  } satisfies ProtocolService));
}
