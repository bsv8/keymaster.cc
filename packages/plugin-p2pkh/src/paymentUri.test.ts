import { expect, it } from "vitest";
import { parsePaymentUri } from "./paymentUri.js";
import { paymentAmountSatoshis } from "./pages/P2pkhTransferPage.js";
const address = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
it("recognizes checksum-valid addresses and BSV payment requests without rounding satoshis", () => {
 expect(parsePaymentUri(address)).toEqual({ address, network: "main" });
 expect(parsePaymentUri(`bsv:${address}?amount=0.00000001&label=Coffee`)).toEqual({ address, network: "main", amount: "0.00000001", label: "Coffee" });
 expect(paymentAmountSatoshis("0.00000001")).toBe("1"); expect(paymentAmountSatoshis("1.23")).toBe("123000000");
});
it("rejects wrong checksums, ambiguous parameters, unknown required fields and invalid amounts", () => {
 for (const value of [address.slice(0,-1)+"U", `bsv:${address}?amount=1&amount=2`, `bsv:${address}?req-extra=1`, `bsv:${address}?amount=1e2`, `bsv:${address}?amount=0`, `bsv:${address}?amount=0.000000001`, `bsv:${address}?amount=21000001`, `https://evil.example/${address}`]) expect(parsePaymentUri(value), value).toBeUndefined();
 expect(paymentAmountSatoshis("-1")).toBeUndefined(); expect(paymentAmountSatoshis("1e2")).toBeUndefined();
});
