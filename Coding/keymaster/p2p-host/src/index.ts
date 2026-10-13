import { createIdentityAdapter, type HostConfig } from "bitcoin-libp2p/libp2p";
import { noise, pureJsCrypto } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, identifyPush } from "@libp2p/identify";
import { createLibp2p } from "libp2p";
/** Noise 身份证明在创建网络 Host 前由钱包授权。只缓存本 Host 的固定
 * X25519 公钥证明，不能拿来签 Peer Record 或另一个静态公钥。
 * Peer Record 仍由 Identify 服务先 seal（签名）再 push，人工等待使用钱包 TTL。
 * host 生命周期结束即擦掉种子/证明；钱包锁定会撤销外部 signer 并停止 Host。 */
export async function createPreparedHost(config: HostConfig) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pair = pureJsCrypto.generateX25519KeyPairFromSeed(seed.slice());
  const staticKey = new Uint8Array(pair.publicKey);
  pair.privateKey.fill(0);
  let proof: Uint8Array | undefined,
    closed = false;
  const assert = () => {
    if (closed) throw Error("Prepared identity is closed");
  };
  const release = () => {
    closed = true;
    seed.fill(0);
    staticKey.fill(0);
    proof?.fill(0);
  };
  try {
    proof = await config.signer.signNoiseStaticKey(staticKey.slice());
    assert();
    const signer = {
      publicKey: () => {
        assert();
        return config.signer.publicKey();
      },
      async signNoiseStaticKey(key: Uint8Array, signal?: AbortSignal) {
        assert();
        if (signal?.aborted) throw Error("identity-cancelled");
        if (
          key.length !== staticKey.length ||
          !key.every((v, i) => v === staticKey[i])
        )
          throw Error("noise-static-key-mismatch");
        return proof!.slice();
      },
      signPeerRecord: config.signer.signPeerRecord.bind(config.signer),
    };
    const identity = createIdentityAdapter(signer, { signTimeoutMs: 300000 });
    let host;
    try {
      host = await createLibp2p({
        privateKey: identity,
        addresses: {
          listen: (config.listenAddrs ?? []).map((x) => x.toString()),
        },
        transports: config.transports ?? [],
        streamMuxers: [yamux(), ...(config.streamMuxers ?? [])],
        connectionEncrypters: [noise({ staticNoiseKey: seed })],
        connectionGater: config.connectionGater,
        services: {
          identify: identify(),
          identifyPush: identifyPush(),
          ...(config.services ?? {}),
        },
        start: config.start,
      });
    } catch (e) {
      identity.close();
      throw e;
    }
    const stop = host.stop.bind(host);
    let stopped: Promise<void> | undefined;
    Object.defineProperty(host, "stop", {
      value: () =>
        (stopped ??= (async () => {
          release();
          identity.close();
          await stop();
        })()),
      configurable: true,
    });
    return host;
  } catch (e) {
    release();
    throw e;
  }
}
