// @vitest-environment node
// 执行 Connect 现有交易构造器、真实钱包 CAS/额度/签名和独立 VLP 解释器。
import { test, expect, afterAll } from "vitest";
import {
  sdkBuildBaseTx,
  sdkBuildInitialDraftSpendTx,
  sdkLoadDraftSpendTx,
  sdkClientSignInitialSpendTx,
  sdkClientSignUpdatedSpendTx,
  feePoolInputTxids,
} from "../../../../packages/plugin-protocol/src/feepoolSdk.js";
import {
  paymentRequester,
  fundingCoin,
  previousTransactions,
  cleanupPayments,
} from "./transfer-fixture.mjs";
import {
  DeviceIdentityKey,
  hex,
  unhex,
  inspectFeePool,
  parseTransaction,
  secpIdentityVerifier,
} from "@vaultlink/sdk";
afterAll(cleanupPayments);
test("Connect production constructor signs funding once; initial/update/close use whole-transaction core and bill 100/50/0", async () => {
  const key = new DeviceIdentityKey(unhex("00".repeat(31) + "01")),
    peer = new DeviceIdentityKey(unhex("00".repeat(31) + "02"));
  try {
    const pub = hex(key.publicKey()),
      counterparty = hex(peer.publicKey()),
      payment = paymentRequester("00".repeat(31) + "01");
    const coin = fundingCoin(pub, 2000),
      evidence = (await previousTransactions("main", [coin]))[0]!;
    await payment({
      action: "register",
      id: "app.connect",
      owner: "connect-app",
      kind: "app",
      network: "main",
      paymentType: "feepool.connect",
    });
    await payment({
      action: "session-open",
      id: "one-connection",
      owner: "connect-app",
    });
    const sources = new Map([[coin.txid, evidence]]),
      amounts: string[] = [];
    let fundingSignatures = 0;
    const signer =
      (stage: "fund" | "state") =>
      async (rawTxHex: string): Promise<string[]> => {
        const prevTransactionHexes = feePoolInputTxids(rawTxHex).map((id) => {
          const raw = sources.get(id);
          if (!raw) throw Error("missing actual evidence");
          return raw;
        });
        const result = (await payment({
          action: "sign-feepool",
          family: "connect",
          stage,
          rawTxHex,
          prevTransactionHexes,
          channelId: "app.connect",
          paymentId: crypto.randomUUID(),
          sessionId: "one-connection",
        })) as { signatures: string[]; amount: string };
        if (stage === "fund") fundingSignatures++;
        else amounts.push(result.amount);
        const review = await inspectFeePool(
          unhex(rawTxHex),
          prevTransactionHexes.map(unhex),
          key.publicKey(),
          "connect",
          stage,
        );
        result.signatures.forEach((signature, i) =>
          expect(
            secpIdentityVerifier.verify(
              review.digests[i]!,
              unhex(signature).slice(0, -1),
              key.publicKey(),
            ),
          ).toBe(true),
        );
        return result.signatures;
      };
    const base = await sdkBuildBaseTx({
      clientUtxos: [{ txid: coin.txid, vout: coin.vout, satoshis: coin.value }],
      clientPublicKeyHex: pub,
      serverPublicKeyHex: counterparty,
      feepoolAmount: 1000,
      feeRate: 1,
      signTransaction: signer("fund"),
    });
    expect(fundingSignatures).toBe(1);
    sources.set(base.txid, base.txHex);
    expect(
      parseTransaction(unhex(base.txHex)).inputs[0]!.script.length,
    ).toBeGreaterThan(0);
    let draft = (
      await sdkBuildInitialDraftSpendTx({
        prevTxId: base.txid,
        totalAmount: 1000,
        serverAmount: 100,
        endHeight: 0,
        clientPublicKeyHex: pub,
        serverPublicKeyHex: counterparty,
        feeRate: 1,
      })
    ).txHex;
    await sdkClientSignInitialSpendTx({
      txHex: draft,
      totalAmount: 1000,
      clientPublicKeyHex: pub,
      serverPublicKeyHex: counterparty,
      signTransaction: signer("state"),
    });
    for (const [paid, sequence] of [
      [150, 0xfffffffe],
      [150, 0xffffffff],
    ]) {
      draft = (
        await sdkLoadDraftSpendTx({
          prevDraftHex: draft,
          locktime: 0,
          sequenceNumber: sequence!,
          serverAmount: paid!,
          serverPublicKeyHex: counterparty,
          clientPublicKeyHex: pub,
          targetAmount: 999,
        })
      ).txHex;
      await sdkClientSignUpdatedSpendTx({
        txHex: draft,
        sourceSatoshis: 1000,
        clientPublicKeyHex: pub,
        serverPublicKeyHex: counterparty,
        signTransaction: signer("state"),
      });
    }
    expect(amounts).toEqual(["100", "50", "0"]);
  } finally {
    key.close();
    peer.close();
  }
});

// 使用实际 go-bitfs 引擎，不伪造其摘要、退款模板或累计交易输出。
import { MultisigPoolEngine, prepareSellerPresign, encodeRefundPresignRequest } from "go-bitfs";
import { createBitfsBuyerPaymentSigner } from "../dist/index.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { serializeTransaction, p2pkhScript, sha256d } from "@vaultlink/sdk";
test("BitFS actual SDK passes transaction bytes: refund, cumulative payment, close and altered digest rejection use core", async () => {
  const key = new DeviceIdentityKey(unhex("00".repeat(31) + "01")),
    seller = new DeviceIdentityKey(unhex("00".repeat(31) + "02")),
    arbiter = new DeviceIdentityKey(unhex("00".repeat(31) + "03"));
  try {
    const engine = new MultisigPoolEngine({
      buyerPublicKey: key.publicKey(),
      sellerPublicKey: seller.publicKey(),
      arbiterPublicKey: arbiter.publicKey(),
    });
    const coin = fundingCoin(hex(key.publicKey()), 2000),
      prior = unhex((await previousTransactions("main", [coin]))[0]!);
    const fund = serializeTransaction({
      version: 1,
      inputs: [
        {
          txid: await sha256d(prior),
          vout: 0,
          script: new Uint8Array(),
          sequence: 0xfffffffe,
        },
      ],
      outputs: [
        { satoshis: 1000n, script: engine.lockingScript() },
        { satoshis: 990n, script: p2pkhScript(key.publicKey()) },
      ],
      locktime: 0,
    });
    const payment = paymentRequester("00".repeat(31) + "01"),
      amounts: string[] = [];
    const signer = createBitfsBuyerPaymentSigner(
      {
        publicKey: () => key.publicKey(),
        async sign(request) {
          expect(request.purpose).toBe("wire_message");
          return secp256k1.sign(request.digest, unhex("00".repeat(31) + "01"), {
            prehash: false,
            lowS: true,
            format: "der",
          });
        },
      },
      {
        network: "main",
        assertActive() {
          key.publicKey();
        },
        async previousTransaction(txid) {
          expect(txid).toBe(hex((await sha256d(fund)).reverse()));
          return fund;
        },
        async requestPayment(command) {
          const result = await payment(command);
          if (command.action === "sign-feepool")
            amounts.push((result as { amount: string }).amount);
          return result;
        },
      },
    );
    let raw = await engine.buildOpeningState(fund, 1000, 1000, 1);
    await engine.signRole(signer, "buyer", raw, 1000n);
    for (const [sequence, paid] of [
      [3, 100],
      [4, 150],
      [0xffffffff, 150],
    ]) {
      raw = await engine.buildState({
        previousRaw: raw,
        poolOutputSatoshis: 1000,
        paymentSequence: sequence!,
        sellerAmountSatoshis: paid!,
        minerFeeRateSatoshisPerKilobyte: 1,
        lockTime: 0,
      });
      await engine.signRole(signer, "buyer", raw, 1000n);
    }
    expect(amounts).toEqual(["0", "100", "50", "0"]);
    await expect(
      signer.sign({
        purpose: "transaction",
        wireKind: 0,
        digest: new Uint8Array(32),
        transactionRaw: raw,
      }),
    ).rejects.toThrow("invalid-signing-digest");
    await expect(
      signer.sign({
        purpose: "transaction",
        wireKind: 0,
        digest: new Uint8Array(32),
      }),
    ).rejects.toThrow("unsupported-transaction");
  } finally {
    key.close();
    seller.close();
    arbiter.close();
  }
});

test("BitFS seller opening uses exact Kind 2 and derives refund amount without fetching not-yet-delivered funding", async()=>{
 const seller=new DeviceIdentityKey(unhex("00".repeat(31)+"01")),buyer=new DeviceIdentityKey(unhex("00".repeat(31)+"02")),arbiter=new DeviceIdentityKey(unhex("00".repeat(31)+"03"));
 try{
  const engine=new MultisigPoolEngine({buyerPublicKey:buyer.publicKey(),sellerPublicKey:seller.publicKey(),arbiterPublicKey:arbiter.publicKey()});
  const coin=fundingCoin(hex(buyer.publicKey()),2000),previous=unhex((await previousTransactions('main',[coin]))[0]!);
  const funding=serializeTransaction({version:1,inputs:[{txid:await sha256d(previous),vout:0,script:new Uint8Array(),sequence:0xfffffffe}],outputs:[{satoshis:1000n,script:engine.lockingScript()}],locktime:0});
  const pay=paymentRequester("00".repeat(31)+"01");
  const sellerSigner=createBitfsBuyerPaymentSigner({publicKey:()=>seller.publicKey(),sign:async()=>{throw Error('opening-must-use-core');}},
    {network:'main',role:'seller',assertActive(){seller.publicKey();},requestPayment:pay,previousTransaction:async()=>{throw Error('funding-not-yet-delivered');}});
  const buyerSigner={publicKey:()=>buyer.publicKey(),sign:async(request:{digest:Uint8Array})=>secp256k1.sign(request.digest,unhex("00".repeat(31)+"02"),{prehash:false,lowS:true,format:'der'})};
  for(const rate of [0n,1n,1000n]){
   const refund=await engine.buildOpeningState(funding,1000,500,Number(rate)),buyerSignature=await engine.signRole(buyerSigner,'buyer',refund,1000n);
   const request=encodeRefundPresignRequest({refundTemplateRaw:refund,buyerPublicKey:buyer.publicKey(),sellerPublicKey:seller.publicKey(),arbiterPublicKey:arbiter.publicKey(),minerFeeRateSatoshisPerKilobyte:rate,buyerRefundTransactionSignature:buyerSignature});
   const result=await prepareSellerPresign(request.bytes(),sellerSigner);
   expect(result.outbound.kind).toBe(3);
  }
 }finally{seller.close();buyer.close();arbiter.close();}
});
