import { test, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SignatureHistory } from "../src/signature-history.js";
import { WalletPayments } from "../src/wallet-payments.js";
import { openActualMigrationDevice } from "./native-migration-device.mjs";
import { VaultLinkHardwareBackend } from "../src/hardware-backend.js";
async function storage() {
  const dir = await mkdtemp(join(tmpdir(), "km-signature-history-"));
  return {
    dir,
    files: {
      async get(path: string) {
        try {
          const bytes = new Uint8Array(await readFile(join(dir, path)));
          return {
            bytes,
            revision: createHash("sha256").update(bytes).digest("hex"),
          };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
          throw e;
        }
      },
      async put(
        path: string,
        bytes: Uint8Array,
        c: { ifRevision?: string; ifNoneMatch?: boolean },
      ) {
        const old = await this.get(path);
        if (
          (c.ifNoneMatch && old) ||
          (c.ifRevision && old?.revision !== c.ifRevision)
        )
          throw Error("conflict");
        await writeFile(join(dir, path) + ".tmp", bytes);
        await rename(join(dir, path) + ".tmp", join(dir, path));
        return { revision: createHash("sha256").update(bytes).digest("hex") };
      },
    },
  };
}
const secret = new Uint8Array(32);
secret[31] = 1;
const pub = Buffer.from(secp256k1.getPublicKey(secret)).toString("hex");
test("真实文件持久化、同身份后端历史、冷启动未完成归为未知，元数据不写入正文", async () => {
  const { dir, files } = await storage();
  try {
    const history = new SignatureHistory(files, "test", pub, "run-1");
    const tickets = await Promise.all(
      ["software", "hardware"].map((backend) =>
        history.start({
          backend: backend as "software" | "hardware",
          operation: "identity.noise-proof",
          channelId: "identity.noise-proof",
          owner: "window-p2p",
          plaintext: "sensitive",
        } as any),
      ),
    );
    await tickets[0]!.update("completed", "automatic");
    const rebooted = new SignatureHistory(files, "test", pub, "run-2");
    expect(await rebooted.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backend: "software",
          state: "completed",
          mode: "automatic",
        }),
        expect.objectContaining({ backend: "hardware", state: "unknown" }),
      ]),
    );
    expect(await readFile(join(dir, "signatures.json"), "utf8")).not.toContain(
      "sensitive",
    );
    await expect(
      new SignatureHistory(files, "main", pub, "run-2").list(),
    ).rejects.toThrow("invalid-signature-history");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("软件签名注册、真实签名与人工拒绝均入历史；拒绝不调用私钥", async () => {
  const { dir, files } = await storage();
  const history = new SignatureHistory(files, "main", pub, "run-1");
  const wallet = await WalletPayments.open(
    files,
    pub,
    () => {},
    async (digest) =>
      secp256k1.sign(digest, secret, {
        prehash: false,
        lowS: true,
        format: "der",
      }),
    "main",
  );
  wallet.setSignatureRecorder((meta) => history.start(meta));
  const sign = () =>
    secp256k1.sign(new Uint8Array(32).fill(7), secret, {
      prehash: false,
      lowS: true,
      format: "der",
    });
  const answer = async (allow: boolean) => {
    await expect
      .poll(
        async () =>
          ((await wallet.handle({ action: "pending" })) as any[]).length,
      )
      .toBe(1);
    const [p] = (await wallet.handle({ action: "pending" })) as any[];
    expect((await history.list()).some(r => r.id === p.historyId)).toBe(true);
    await wallet.handle({ action: "answer", id: p.id, allow });
  };
  try {
    const first = wallet.authorizeSignature("identity.noise-proof", sign);
    await answer(true);
    expect(await first).toBeInstanceOf(Uint8Array);
    expect(await history.list()).toEqual([
      expect.objectContaining({ operation: "signing.register", state: "completed", mode: "manual" }),
      expect.objectContaining({ operation: "identity.noise-proof", state: "completed", mode: "automatic" }),
    ]);
    await wallet.handle({
      action: "signing-configure",
      id: "identity.noise-proof",
      mode: "manual",
      revision: 1,
    });
    let signed = false;
    const rejected = wallet.authorizeSignature("identity.noise-proof", () => {
      signed = true;
      return sign();
    });
    void rejected.catch(() => {});
    await answer(false);
    await expect(rejected).rejects.toThrow("denied");
    expect(signed).toBe(false);
    expect((await history.list())[0]).toMatchObject({
      state: "denied",
      mode: "manual",
    });
  } finally {
    wallet.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("真实 C++ 硬件身份签名失败也留下结果，不把主机默认值当硬件授权方式", async () => {
  const { dir, files } = await storage();
  const device = await openActualMigrationDevice(VaultLinkHardwareBackend);
  const history = new SignatureHistory(files, "main", pub, "run-1");
  device.backend.setSignatureRecorder((meta) => history.start(meta));
  try {
    await expect(
      device.backend.signNetworkIdentity("noise", {
        staticKey: new Uint8Array(32),
      }),
    ).rejects.toThrow();
    const rows = await history.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      backend: "hardware",
      operation: "identity.noise-proof",
      state: "failed",
      mode: "unknown",
    });
  } finally {
    await device.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
