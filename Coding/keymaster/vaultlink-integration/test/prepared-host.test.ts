import { expect, test } from "vitest";
import { LocalSigner } from "bitcoin-libp2p/signer";
import { webSockets } from "@libp2p/websockets";
import { createPreparedHost } from "@keymaster/p2p-host";
test("真实 libp2p Host 先获取 Noise 证明才构造传输，关闭后可再次建立新证明", async () => {
  const privateKey = new Uint8Array(32);
  privateKey[31] = 1;
  const real = new LocalSigner(privateKey);
  let signatures = 0,
    transports = 0;
  const signer = {
    publicKey: () => real.publicKey(),
    async signNoiseStaticKey(key: Uint8Array, signal?: AbortSignal) {
      signatures++;
      return real.signNoiseStaticKey(key, signal);
    },
    signPeerRecord: real.signPeerRecord.bind(real),
  };
  for (let i = 0; i < 2; i++) {
    const expected = i + 1;
    const factory = webSockets();
    const host = await createPreparedHost({
      signer,
      transports: [
        (components) => {
          expect(signatures).toBe(expected);
          transports++;
          return factory(components);
        },
      ],
      start: false,
    });
    expect(signatures).toBe(expected);
    expect(host.peerId.toString()).toBeTruthy();
    await host.stop();
  }
  expect(signatures).toBe(2);
  expect(transports).toBe(2);
});

test("两个真实 WebSocket/libp2p Host 完成 Noise 握手，预签公钥与实际静态密钥一致", async () => {
  const { multiaddr } = await import("@multiformats/multiaddr");
  const secrets = [1, 2].map((n) => {
    const key = new Uint8Array(32);
    key[31] = n;
    return key;
  });
  const signers = secrets.map((key) => new LocalSigner(key));
  const counts = [0, 0];
  const wrap = (i: number) => ({
    publicKey: () => signers[i]!.publicKey(),
    async signNoiseStaticKey(key: Uint8Array, signal?: AbortSignal) {
      counts[i]++;
      return signers[i]!.signNoiseStaticKey(key, signal);
    },
    signPeerRecord: signers[i]!.signPeerRecord.bind(signers[i]!),
  });
  const hosts: Awaited<ReturnType<typeof createPreparedHost>>[] = [];
  try {
    hosts.push(
      await createPreparedHost({
        signer: wrap(0),
        transports: [webSockets()],
        listenAddrs: [multiaddr("/ip4/127.0.0.1/tcp/0/ws")],
        start: true,
      }),
    );
    hosts.push(
      await createPreparedHost({
        signer: wrap(1),
        transports: [webSockets()],
        connectionGater: { denyDialMultiaddr: async () => false },
        start: true,
      }),
    );
    const connection = await hosts[1]!.dial(hosts[0]!.getMultiaddrs()[0]!, {
      signal: AbortSignal.timeout(10000),
    });
    expect(connection.remotePeer.toString()).toBe(hosts[0]!.peerId.toString());
    expect(counts).toEqual([1, 1]);
  } finally {
    await Promise.all(hosts.map((h) => h.stop()));
  }
}, 20000);
