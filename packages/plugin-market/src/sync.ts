import type { AppMarketSync } from "@keymaster/contracts";
export function createMarketSync(signal: AbortSignal): AppMarketSync {
 let inflight: Promise<Awaited<ReturnType<AppMarketSync["sync"]>>> | undefined;
 return { sync() { if(signal.aborted)return Promise.reject(new Error("Market synchronizer stopped")); return inflight ??= (async()=>{
  const env=(import.meta as unknown as {env?:Record<string,string>}).env;
  const base=(env?.VITE_KEYMASTER_MARKET_URL??"https://market.bsv8.com").replace(/\/?$/,"/");
  const response=await fetch(new URL("v1/market",base),{headers:{accept:"application/json"},signal});
  if(!response.ok)throw new Error(`Market status ${response.status}`);
  const body=await response.json();if(!Array.isArray(body?.entries))throw new Error("Invalid market snapshot");return body.entries;
 })().finally(()=>{inflight=undefined}); } };
}
