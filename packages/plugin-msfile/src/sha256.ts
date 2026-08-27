// packages/plugin-msfile/src/sha256.ts
// SHA-256：一次性 WebCrypto 摘要 + 增量实现。
//
// 增量实现（审查修复）用于 Window executor 的流式内容校验：
// attachment 分片到达时 update()，结束时 digest()，避免为 16 MiB Seed
// 先完整缓存再计算摘要。纯 JS 实现与 WebCrypto 结果交叉验证。

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** FIPS 180-4 增量 SHA-256。digest() 后实例不可复用。 */
export class IncrementalSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockFill = 0;
  private lengthBytes = 0;
  private done = false;

  update(chunk: Uint8Array): this {
    if (this.done) throw new Error("sha256 already finalized");
    this.lengthBytes += chunk.length;
    let offset = 0;
    if (this.blockFill > 0) {
      const take = Math.min(64 - this.blockFill, chunk.length);
      this.block.set(chunk.subarray(0, take), this.blockFill);
      this.blockFill += take;
      offset = take;
      if (this.blockFill === 64) {
        this.compress(this.block);
        this.blockFill = 0;
      }
    }
    while (offset + 64 <= chunk.length) {
      this.compress(chunk.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < chunk.length) {
      const rest = chunk.subarray(offset);
      this.block.set(rest, 0);
      this.blockFill = rest.length;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.done) throw new Error("sha256 already finalized");
    // FIPS 180-4 padding：0x80 + 零填充 + 64 位大端比特长度。
    const bitLengthHi = Math.floor(this.lengthBytes / 0x20000000);
    const bitLengthLo = (this.lengthBytes << 3) >>> 0;
    let padIndex = this.blockFill;
    this.block[padIndex] = 0x80;
    padIndex += 1;
    if (padIndex > 56) {
      // 剩余空间放不下长度字段：先补零压缩一块，再在新块里写长度。
      this.block.fill(0, padIndex);
      this.compress(this.block);
      padIndex = 0;
    }
    this.block.fill(0, padIndex, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, bitLengthHi, false);
    view.setUint32(60, bitLengthLo, false);
    this.compress(this.block);
    this.done = true;
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, this.state[i]!, false);
    return out;
  }

  private compress(block: Uint8Array): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      w[i] = ((block[i * 4]! << 24) | (block[i * 4 + 1]! << 16) | (block[i * 4 + 2]! << 8) | block[i * 4 + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0;
    this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0;
    this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0;
    this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** 分片摘要：等价于对拼接后的完整字节做一次性 sha256。 */
export async function sha256Chunks(chunks: Uint8Array[]): Promise<Uint8Array> {
  const hasher = new IncrementalSha256();
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.digest();
}

/**
 * 把内容字节转成可跨 Worker transfer 的 ArrayBuffer。
 * 已独占底层 buffer 时零拷贝；subarray 视图才 slice（审查修复）。
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
