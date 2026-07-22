import type { ComponentType } from "react";
import type { TransferOffer } from "@keymaster/contracts";

export interface TransferRequest { offer: TransferOffer; sourceId: string; draft?: unknown; quote?: unknown; }
export interface TransferSource { id: string; order: number; label: string; supports?(offer: TransferOffer): boolean; createDraft?(offer: TransferOffer): unknown; }
export interface TransferQuoteProvider { id: string; order: number; quote(input: TransferRequest): Promise<unknown>; }
export interface TransferReviewSection { id: string; order: number; component: ComponentType; }
export interface TransferSubmitHandler { id: string; order: number; submit(input: TransferRequest): Promise<unknown>; }

export interface TransferFeatureCapability {
  registerSource(source: TransferSource): () => void;
  registerQuoteProvider(provider: TransferQuoteProvider): () => void;
  registerReviewSection(section: TransferReviewSection): () => void;
  registerSubmitHandler(handler: TransferSubmitHandler): () => void;
  subscribe(listener: () => void): () => void;
  listSources(): TransferSource[];
  listQuoteProviders(): TransferQuoteProvider[];
  listReviewSections(): TransferReviewSection[];
  listSubmitHandlers(): TransferSubmitHandler[];
}

export function createTransferFeatureCapability(): TransferFeatureCapability {
  const sources = new Map<string, TransferSource>();
  const quotes = new Map<string, TransferQuoteProvider>();
  const sections = new Map<string, TransferReviewSection>();
  const submits = new Map<string, TransferSubmitHandler>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const put = <T extends { id: string }>(map: Map<string, T>, value: T, kind: string) => {
    if (map.has(value.id)) throw new Error(`Transfer ${kind} "${value.id}" is already registered`);
    map.set(value.id, value);
    notify();
    return () => { if (map.delete(value.id)) notify(); };
  };
  const ordered = <T extends { id: string; order: number }>(map: Map<string, T>) => [...map.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return {
    registerSource: (value) => put(sources, value, "source"),
    registerQuoteProvider: (value) => put(quotes, value, "quote provider"),
    registerReviewSection: (value) => put(sections, value, "review section"),
    registerSubmitHandler: (value) => put(submits, value, "submit handler"),
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    listSources: () => ordered(sources),
    listQuoteProviders: () => ordered(quotes),
    listReviewSections: () => ordered(sections),
    listSubmitHandlers: () => ordered(submits)
  };
}
