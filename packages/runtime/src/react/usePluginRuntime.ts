import { useMemo } from "react";
import type { PluginGraph, PluginState, PluginReverseDep } from "@keymaster/contracts";
import type { PluginHost } from "../pluginHostContract.js";
import { usePluginHost, useHostVersion } from "./PluginHostProvider.js";

/** Trusted diagnostics view. Recovery never persists an enable/disable preference. */
export interface UsePluginRuntime {
  state(id: string): PluginState;
  graph(): PluginGraph;
  reverseDeps(id: string): PluginReverseDep[];
  retry(id: string): Promise<void>;
  version(): number;
  manifests(): string[];
  installed(): string[];
  isRunning(id: string): boolean;
  getManifest(id: string): import("@keymaster/contracts").PluginManifest | undefined;
  hasCapability(key: string): boolean;
}

export function usePluginRuntime(): UsePluginRuntime {
  const host = usePluginHost();
  const version = useHostVersion();
  return useMemo(() => ({
    state: host.state,
    graph: host.graph,
    reverseDeps: host.reverseDeps,
    retry: host.retry,
    version: host.version,
    manifests: host.manifests,
    installed: host.installed,
    isRunning: (id: string) => host.state(id).kind === "enabled",
    getManifest: host.getManifest,
    hasCapability: (key: string) => host.capabilities.descriptors().some(c => c.id === key),
  }), [host, version]);
}

export function useHost(): PluginHost {
  return usePluginHost();
}
