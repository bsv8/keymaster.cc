import type { WindowP2pExecutorConcurrencyConfig } from "@keymaster/contracts/window-p2p";
import { MSFILE_READ_CONCURRENCY_RECOMMENDED, MSFILE_SELLER_SETTINGS_DEFAULT, normalizeMsFileReadConcurrencySettings, type MsFileReadConcurrencySettings, type CoordinatorMsFileStateEvent } from "@keymaster/contracts";
import { buildWindowP2pConcurrencyConfig } from "./executorTransport.js";
export function createMsFileWorkerProjection(ports: {
  session(): { epoch: string; unlocked: boolean };
  service(): { describeState(): Omit<CoordinatorMsFileStateEvent, "topic" | "type" | "msfileRevision" | "sessionEpoch"> } | undefined;
  configChanged(): Promise<unknown>; pump(): void; publish(event: CoordinatorMsFileStateEvent): void;
}) {
  let msfileRevision = 0;

  let lastMsFileState: CoordinatorMsFileStateEvent | undefined;

  let msfileReadConcurrencySettings: MsFileReadConcurrencySettings = { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };

  let windowP2pExecutorConfigVersion = 0;

  let windowP2pExecutorConfigSignature = JSON.stringify(msfileReadConcurrencySettings);

  let windowP2pExecutorConcurrencyConfig: WindowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(
    msfileReadConcurrencySettings,
    windowP2pExecutorConfigVersion,
  );

  function emitMsFileState(): void {
    msfileRevision += 1;
    const state = ports.service()?.describeState();
    const event: CoordinatorMsFileStateEvent = {
      topic: "msfile.state",
      type: "msfile.state.changed",
      msfileRevision,
      sessionEpoch: ports.session().epoch,
      status: state?.status ?? (ports.session().unlocked ? "unconfigured" : "unavailable"),
      supplierGeneration: state?.supplierGeneration ?? 0,
      globalSettings: state?.globalSettings ?? null,
      mediaBlockReadConcurrency: state?.mediaBlockReadConcurrency ?? msfileReadConcurrencySettings.mediaBlockReadConcurrency,
      globalSeedReadConcurrency: state?.globalSeedReadConcurrency ?? msfileReadConcurrencySettings.globalSeedReadConcurrency,
      globalBlockReadConcurrency: state?.globalBlockReadConcurrency ?? msfileReadConcurrencySettings.globalBlockReadConcurrency,
      globalStatConcurrency: state?.globalStatConcurrency ?? msfileReadConcurrencySettings.globalStatConcurrency,
      sellerSettings: state?.sellerSettings ?? { ...MSFILE_SELLER_SETTINGS_DEFAULT, supportedArbiterPublicKeys: [] },
      sellerRuntimeStatus: state?.sellerRuntimeStatus ?? (ports.session().unlocked ? "disabled" : "waiting-unlock"),
      pendingApprovals: state?.pendingApprovals ?? []
    };
    const nextConcurrency = normalizeMsFileReadConcurrencySettings(event) ?? msfileReadConcurrencySettings;
    const nextSignature = JSON.stringify(nextConcurrency);
    if (nextSignature !== windowP2pExecutorConfigSignature) {
      msfileReadConcurrencySettings = nextConcurrency;
      windowP2pExecutorConfigSignature = nextSignature;
      windowP2pExecutorConfigVersion += 1;
      windowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(nextConcurrency, windowP2pExecutorConfigVersion);
      void ports.configChanged().catch(() => undefined);
      ports.pump();
    }
    lastMsFileState = event;
    ports.publish(event);
  }
  return {
    get msfileRevision() { return msfileRevision; }, set msfileRevision(value: typeof msfileRevision) { msfileRevision = value; },
    get lastMsFileState() { return lastMsFileState; }, set lastMsFileState(value: typeof lastMsFileState) { lastMsFileState = value; },
    get msfileReadConcurrencySettings() { return msfileReadConcurrencySettings; }, set msfileReadConcurrencySettings(value: typeof msfileReadConcurrencySettings) { msfileReadConcurrencySettings = value; },
    get windowP2pExecutorConfigVersion() { return windowP2pExecutorConfigVersion; }, set windowP2pExecutorConfigVersion(value: typeof windowP2pExecutorConfigVersion) { windowP2pExecutorConfigVersion = value; },
    get windowP2pExecutorConfigSignature() { return windowP2pExecutorConfigSignature; }, set windowP2pExecutorConfigSignature(value: typeof windowP2pExecutorConfigSignature) { windowP2pExecutorConfigSignature = value; },
    get windowP2pExecutorConcurrencyConfig() { return windowP2pExecutorConcurrencyConfig; }, set windowP2pExecutorConcurrencyConfig(value: typeof windowP2pExecutorConcurrencyConfig) { windowP2pExecutorConcurrencyConfig = value; },
    emitMsFileState,
  };
}
