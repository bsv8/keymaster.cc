import { requireWocNetwork } from "@keymaster/contracts";
import type { BsvNetwork, WocService, WocSpentOutput } from "@keymaster/contracts";
import type { InputObserver, InputObservation } from "@keymaster/utxo-manager";

function inputDiagnostic(error: unknown) {
  const value = error && typeof error === "object" ? error as { status?: unknown; body?: unknown } : {};
  return { error: error instanceof Error ? error.message : String(error), ...(typeof value.status === "number" ? { status: value.status } : {}), ...(typeof value.body === "string" ? { body: value.body } : {}) };
}

/** HTTP and scheduling stay in the host; manager receives only outpoint facts. */
export function createWocInputObserver(woc: Pick<WocService, "identity" | "getSpentOutput" | "getSpentOutputs">, network: BsvNetwork, onDiagnostic?: (value: unknown) => void): InputObserver {
  return { async observeInputs(keys) {
    const points = keys.map(key => { const [txid, index] = key.split(":"); return { txid: txid!, vout: Number(index) }; });
    const facts: InputObservation[] = [];
    for (let start = 0; start < points.length; start += 20) {
      const chunk = points.slice(start, start + 20);
      const known = new Map<string, WocSpentOutput>();
      if (typeof woc.getSpentOutputs === "function") {
        try {
          const results = await requireWocNetwork(woc, network).getSpentOutputs(chunk);
          onDiagnostic?.({ kind: "batch", network, outpoints: chunk, results });
          for (const row of results) {
            const key = `${row.outpoint.txid}:${row.outpoint.vout}`;
            if (row.status === "spent" && row.spender && keys.includes(key)) known.set(key, row.spender);
          }
        } catch (error) { onDiagnostic?.({ kind: "batch-error", network, ...inputDiagnostic(error) }); }
      }
      for (let i = 0; i < chunk.length; i++) {
        const key = keys[start + i]!;
        let spender = known.get(key);
        let status: InputObservation["status"] = "unknown";
        if (!spender) {
          try {
            const result = await requireWocNetwork(woc, network).getSpentOutput(chunk[i]!.txid, chunk[i]!.vout);
            onDiagnostic?.({ kind: "single", network, outpoint: key, status: result === null ? 404 : 200, result });
            if (result === null) status = "unspent";
            else spender = result;
          } catch (error) { onDiagnostic?.({ kind: "single-error", network, outpoint: key, ...inputDiagnostic(error) }); }
        }
        if (spender && spender.status !== "confirmed" && spender.status !== "unconfirmed") spender = undefined;
        facts.push(spender ? { outpoint: key, status: "spent", txid: spender.txid, vin: spender.vin, confirmed: spender.status === "confirmed" } : { outpoint: key, status });
      }
    }
    return facts;
  } };
}
