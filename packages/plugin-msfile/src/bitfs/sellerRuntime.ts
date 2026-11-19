import type { VerifiedHashRequest } from "bsv8-channel-protocol/hash-request";
import type { BitfsSellerMatch } from "keymaster-bitfs";
import { deriveSupplierPeerId, normalizeSupplierAddress } from "../supplierConfig.js";

export function selectMsFileSellerTransport(
  request: VerifiedHashRequest,
  allowLoopbackWs: boolean,
): Pick<BitfsSellerMatch, "transport" | "addresses"> | undefined {
  const expectedPeerId = deriveSupplierPeerId(request.from_public_key);
  const addresses: string[] = [];
  let hasWebRtcSdpLocator = false;
  for (const locator of request.body.locators) {
    if (locator.kind === "webrtc-sdp") {
      hasWebRtcSdpLocator = true;
      continue;
    }
    const parsed = normalizeSupplierAddress(locator.address, expectedPeerId, { allowLoopbackWs });
    if (parsed.ok && !addresses.includes(parsed.value.normalized)) addresses.push(parsed.value.normalized);
  }
  if (addresses.length === 0 && !hasWebRtcSdpLocator) return undefined;
  return { transport: hasWebRtcSdpLocator ? "webrtc-sdp" : "multiaddr", addresses };
}
