import { equal, fail, fixed, u32 } from "./bytes.js";
import { decode, encode, object } from "./cbor.js";
import { FrameReader, frame, Type } from "./frame.js";
import { DeviceHandshake, HostHandshake, parseAck, verifyPossession, } from "./handshake.js";
import { ProtocolClient } from "./client.js";
/** 真实字节管道，保留合并读取的多帧；握手/业务共用，避免在阶段切换时丢掉尾帧。 */
export class PacketLink {
    transport;
    reader = new FrameReader();
    queue = [];
    reading = false;
    constructor(transport) {
        this.transport = transport;
    }
    async read(timeoutMs = 60000) {
        if (this.reading)
            fail("concurrent-read");
        this.reading = true;
        let timer;
        try {
            return await Promise.race([
                this.readNext(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        void this.transport.close();
                        reject(new Error("link-timeout"));
                    }, timeoutMs);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            this.reading = false;
        }
    }
    async readNext() {
        while (!this.queue.length) {
            const b = await this.transport.read();
            if (b === null)
                fail("disconnected");
            this.queue.push(...this.reader.feed(b));
        }
        return this.queue.shift();
    }
    async send(f) {
        await this.transport.write(frame(f));
    }
    /** Client 专用读取视图：把已缓冲尾帧重新编码，之后沿用同一字节管道。 */
    clientTransport() {
        return {
            read: async () => frame(await this.read(8000)),
            write: (b) => this.transport.write(b),
            close: () => this.transport.close(),
        };
    }
}
export async function connectHost(transport, generations, expectedPublicKey, verifier, confirmPairing, capabilities = [0x221]) {
    return (await connectVerifiedHost(transport, generations, expectedPublicKey, verifier, confirmPairing, capabilities)).client;
}
/** 首次绑定专用：两端明确配对并证明持有权后才交付公钥。
 * 此入口不用于已有钱包重连，不能把 wrong-key 转成首次绑定。
 */
export function enrollHost(transport, generations, verifier, confirmPairing, capabilities = [0x221]) {
    return connectVerifiedHost(transport, generations, null, verifier, confirmPairing, capabilities);
}
async function connectVerifiedHost(transport, generations, expectedPublicKey, verifier, confirmPairing, capabilities) {
    const link = new PacketLink(transport), h = new HostHandshake();
    let keys;
    try {
        await link.send({
            type: Type.HELLO,
            seq: 0,
            payload: encode((await h.begin(generations, capabilities))),
        });
        const ackFrame = await link.read();
        if (ackFrame.type !== Type.HELLO_ACK || ackFrame.seq !== 0)
            fail("bad-hello");
        const ack = decode(ackFrame.payload);
        // 未绑定只接受本次 ACK 的候选 Key；候选尚未认证，不向调用者发布。
        const identity = expectedPublicKey?.slice() ?? parseAck(ack).publicKey.slice();
        keys = await h.acceptAck(ack, identity);
        if (!(await confirmPairing(keys.pairingCode)))
            fail("pairing-denied");
        await link.send(await keys.send.seal(Type.PAIR_CONFIRM, encode({ code: keys.pairingCode })));
        let f = await link.read(60000); // 用户在设备核对配对码的时间，不是业务免确认授权。
        if (f.type !== Type.PAIR_OK)
            fail("bad-pair");
        const paired = object(decode(await keys.receive.open(f)), ["paired"]);
        if (paired.paired !== true)
            fail("pairing-denied");
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        await link.send(await keys.send.seal(Type.POSSESSION_PROVE, encode({ challenge })));
        f = await link.read();
        if (f.type !== Type.POSSESSION_OK)
            fail("bad-proof");
        const proof = object(decode(await keys.receive.open(f)), [
            "challenge",
            "publicKey",
            "sessionId",
            "sessionEpoch",
            "signature",
        ]);
        if (!(proof.publicKey instanceof Uint8Array) ||
            !equal(proof.publicKey, identity) ||
            !(proof.challenge instanceof Uint8Array) ||
            !equal(proof.challenge, challenge) ||
            typeof proof.sessionId !== "number" ||
            proof.sessionEpoch !== 1 ||
            !(proof.signature instanceof Uint8Array))
            fail("bad-proof");
        await verifyPossession(verifier, keys.transcript, identity, proof.sessionId, challenge, proof.signature);
        const a = ack;
        const binding = {
            sessionId: String(proof.sessionId),
            sessionEpoch: u32(proof.sessionEpoch),
            connectionId: a.connectionId,
            deviceRunId: a.deviceRunId,
        };
        return { client: new ProtocolClient(link.clientTransport(), keys.send, keys.receive, binding), publicKey: identity.slice() };
    }
    catch (e) {
        keys?.send.close();
        keys?.receive.close();
        await transport.close();
        throw e;
    }
}
export async function acceptDevice(transport, key, deviceRunId, connectionId, confirmPairing, capabilities = [0x221]) {
    const link = new PacketLink(transport);
    let keys;
    try {
        const f = await link.read();
        if (f.type !== Type.HELLO || f.seq !== 0)
            fail("bad-hello");
        const result = await new DeviceHandshake().acceptHello(decode(f.payload), key.publicKey(), deviceRunId, connectionId, capabilities);
        keys = result.keys;
        await link.send({
            type: Type.HELLO_ACK,
            seq: 0,
            payload: encode(result.ack),
        });
        if (!(await confirmPairing(keys.pairingCode)))
            fail("pairing-denied");
        const pairFrame = await link.read();
        if (pairFrame.type !== Type.PAIR_CONFIRM)
            fail("bad-pair");
        const pair = object(decode(await keys.receive.open(pairFrame)), ["code"]);
        if (pair.code !== keys.pairingCode)
            fail("bad-pair");
        await link.send(await keys.send.seal(Type.PAIR_OK, encode({ paired: true })));
        const proofFrame = await link.read();
        if (proofFrame.type !== Type.POSSESSION_PROVE)
            fail("bad-proof");
        const proof = object(decode(await keys.receive.open(proofFrame)), [
            "challenge",
        ]);
        if (!(proof.challenge instanceof Uint8Array))
            fail("bad-proof");
        fixed(proof.challenge, 32);
        const random = crypto.getRandomValues(new Uint32Array(1))[0];
        const sessionId = random || 1;
        const signature = await key.provePossession(keys.transcript, sessionId, proof.challenge);
        await link.send(await keys.send.seal(Type.POSSESSION_OK, encode({
            challenge: proof.challenge,
            publicKey: key.publicKey(),
            sessionId,
            sessionEpoch: 1,
            signature,
        })));
        return {
            link,
            keys,
            binding: {
                sessionId: String(sessionId),
                sessionEpoch: 1,
                connectionId,
                deviceRunId,
            },
        };
    }
    catch (e) {
        keys?.send.close();
        keys?.receive.close();
        await transport.close();
        throw e;
    }
}
