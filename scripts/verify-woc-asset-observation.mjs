#!/usr/bin/env node

const WOC_BASE = "https://api.whatsonchain.com/v1/bsv";

function parseArgs(argv) {
  const args = {
    networks: ["main", "test"],
    mode: "auto",
    timeoutMs: 15_000
  };
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    const next = argv[i + 1];
    switch (cur) {
      case "--network":
        args.networks = [expectValue(cur, next)];
        i += 1;
        break;
      case "--mode":
        args.mode = expectValue(cur, next);
        i += 1;
        break;
      case "--address":
        args.address = expectValue(cur, next);
        i += 1;
        break;
      case "--origin":
        args.origin = expectValue(cur, next);
        i += 1;
        break;
      case "--outpoint":
        args.outpoint = expectValue(cur, next);
        i += 1;
        break;
      case "--expect-empty":
        args.expectEmpty = true;
        break;
      case "--expect-404":
        args.expect404 = true;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(expectValue(cur, next));
        i += 1;
        break;
      case "--help":
      case "-h":
        printHelpAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${cur}`);
    }
  }
  return args;
}

function expectValue(flag, value) {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelpAndExit(code) {
  console.log([
    "Usage:",
    "  node scripts/verify-woc-asset-observation.mjs --mode auto --network main|test ...",
    "",
    "Modes:",
    "  auto      Probe whichever inputs are provided.",
    "  bsv21     Verify BSV-21 list/balance by address (+ optional origin).",
    "  1sat      Verify 1Sat inscription by outpoint.",
    "",
    "Flags:",
    "  --address <base58check>",
    "  --origin <token origin txid_vout>",
    "  --outpoint <txid_vout>",
    "  --network <main|test>",
    "  --expect-empty",
    "  --expect-404",
    "  --timeout-ms <number>"
  ].join("\n"));
  process.exit(code);
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, json: tryParseJson(body) };
  } finally {
    clearTimeout(timeout);
  }
}

function tryParseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function toNetworkPath(network) {
  if (network !== "main" && network !== "test") {
    throw new Error(`Unsupported network: ${network}`);
  }
  return network;
}

async function probeBsv21(network, address, origin, timeoutMs) {
  const listUrl = `${WOC_BASE}/${toNetworkPath(network)}/token/bsv21/${encodeURIComponent(address)}/balance`;
  const listRes = await fetchJson(listUrl, timeoutMs);
  if (!listRes.ok) {
    return { ok: false, kind: "bsv21-list", url: listUrl, ...listRes };
  }
  const list = Array.isArray(listRes.json?.result) ? listRes.json.result : [];
  const result = {
    ok: true,
    kind: "bsv21-list",
    url: listUrl,
    status: listRes.status,
    count: list.length,
    result: list
  };
  if (!origin) return result;

  const balanceUrl = `${WOC_BASE}/${toNetworkPath(network)}/token/bsv21/${encodeURIComponent(address)}/balance/${encodeURIComponent(origin)}`;
  const balanceRes = await fetchJson(balanceUrl, timeoutMs);
  if (!balanceRes.ok) {
    return { ok: false, kind: "bsv21-balance", url: balanceUrl, ...balanceRes, list: result };
  }
  return {
    ...result,
    balanceUrl,
    balanceStatus: balanceRes.status,
    balance: balanceRes.json ?? tryParseJson(balanceRes.body)
  };
}

async function probe1Sat(network, outpoint, timeoutMs) {
  const url = `${WOC_BASE}/${toNetworkPath(network)}/token/1satordinals/${encodeURIComponent(outpoint)}`;
  const res = await fetchJson(url, timeoutMs);
  if (!res.ok) {
    return { ok: false, kind: "1sat", url, ...res };
  }
  return {
    ok: true,
    kind: "1sat",
    url,
    status: res.status,
    inscription: res.json ?? tryParseJson(res.body)
  };
}

function assertOutcome(args, outcome) {
  if (args.expect404) {
    if (outcome.status !== 404) {
      throw new Error(`Expected HTTP 404 but got ${outcome.status ?? "no-status"} for ${outcome.url}`);
    }
    return;
  }
  if (args.expectEmpty && outcome.kind === "bsv21-list") {
    if (outcome.count !== 0) {
      throw new Error(`Expected empty BSV-21 list but got ${outcome.count} entries for ${outcome.url}`);
    }
  }
  if (!outcome.ok) {
    throw new Error(`WOC probe failed: ${outcome.status ?? "no-status"} ${outcome.body?.slice(0, 200) ?? ""}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const probes = [];

  if (args.mode === "bsv21" || args.mode === "auto") {
    if (!args.address) {
      throw new Error("--address is required for bsv21 mode");
    }
    for (const network of args.networks) {
      probes.push(await probeBsv21(network, args.address, args.origin, args.timeoutMs));
    }
  }

  if (args.mode === "1sat" || args.mode === "auto") {
    if (!args.outpoint) {
      throw new Error("--outpoint is required for 1sat mode");
    }
    for (const network of args.networks) {
      probes.push(await probe1Sat(network, args.outpoint, args.timeoutMs));
    }
  }

  if (probes.length === 0) {
    throw new Error("No probes requested");
  }

  for (const probe of probes) {
    assertOutcome(args, probe);
  }

  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), probes }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
