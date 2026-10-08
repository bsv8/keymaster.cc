// Forum 协议互操作黄金向量。
//
// 这些 hex 全部来自服务端工作区 `/home/david/Workspaces/BSV8_Forum`
// 的 `internal/protocol/messages_test.go` 与 `internal/protocol/layout_test.go`，
// 不是本实现自己算出来的。作用是让「TS 编码 ↔ Go 编码」成为一条可执行的
// 断言，而不是靠两边各自签自己验。

/** 固定测试标量；派生签名因此在每个实现里都是同一串字节。 */
export const FORUM_TEST_PRIVATE_KEY_HEX = "1111111111111111111111111111111111111111111111111111111111111111";
export const OPERATOR_TEST_PRIVATE_KEY_HEX = "2222222222222222222222222222222222222222222222222222222222222222";
export const OTHER_TEST_PRIVATE_KEY_HEX = "3333333333333333333333333333333333333333333333333333333333333333";

/**
 * `["bsv8.forum.1", "bsv8 论坛", 4, [[<32 字节 0x01>, 0]]]`
 *
 *   84          4 项数组
 *   6c "bsv8.forum.1"  12 字节文本
 *   6b "bsv8 论坛"     11 字节文本（5 个已编码字节后是 6 个 UTF-8 字节）
 *   04          无符号 4
 *   81          input 列表：1 项
 *   82          列表项：[txid, vout] 对
 *   58 20 <32 字节>  显示顺序 txid，作为字节串
 *   00          无符号 0
 */
export const FORUM_OBJECT_VECTOR =
  "846c627376382e666f72756d2e316b6273763820e8aebae59d9b04" +
  "81825820010101010101010101010101010101010101010101010101010101010101010100";

/** RFC 6979 确定性签名、严格 DER、low-S。 */
export const FORUM_SIGNATURE_VECTOR =
  "304402202b928b6f9ad77aeb757fa65fd5c927d50339725a609a8c90d4f96d09d9d408fd" +
  "02200db478604c08c3cd8d5d3c9a9afca15a7bf8d2888e7594aabd3d56256e750460";

/**
 * `["bsv8.forum.1", "v", 1, <八个边界 input>]`
 *
 * 这些 head 让编码可以肉眼核对：
 *   84                 4 项数组
 *   6c "bsv8.forum.1"
 *   61 "v"
 *   01                 无符号 1
 *   88                 input 列表：8 项
 *   82 5820 00..1f 00      vout 0，一字节
 *   82 5820 20..3f 17      vout 23，一字节
 *   82 5820 40..5f 1818    vout 24，两字节
 *   82 5820 60..7f 18ff    vout 255，两字节
 *   82 5820 80..9f 190100  vout 256，三字节
 *   82 5820 a0..bf 19ffff  vout 65535，三字节
 *   82 5820 c0..df 1a00010000    vout 65536，五字节
 *   82 5820 e0..ff 1affffffff    vout 4294967295，五字节
 */
export const FORUM_INPUTS_VECTOR =
  "846c627376382e666f72756d2e3161760188825820" +
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00" +
  "825820202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f17" +
  "825820404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f1818" +
  "825820606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f18ff" +
  "825820808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f190100" +
  "825820a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf19ffff" +
  "825820c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf1a00010000" +
  "825820e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff1affffffff";

/** uint64 边界的链上编码。 */
export const MINIMAL_UINT_VECTORS: readonly (readonly [bigint, string])[] = Object.freeze([
  [0n, "00"],
  [1n, "01"],
  [255n, "ff"],
  [256n, "0100"],
  [65535n, "ffff"],
  [65536n, "010000"],
  [0xffffffffffffffffn, "ffffffffffffffff"],
]);

/** CBOR 无符号整数边界：每个 head 形式变化点。 */
export const CBOR_BOUNDARY_INTEGERS: readonly bigint[] = Object.freeze([
  0n,
  23n,
  24n,
  255n,
  256n,
  65535n,
  65536n,
  4294967295n,
  4294967296n,
  0xffffffffffffffffn,
]);

/** uint64 最大值的 CBOR head。 */
export const CBOR_MAX_UINT64_VECTOR = "1bffffffffffffffff";

/** 非最短 head 一律拒绝：这些是「同值不同拼写」的反例。 */
export const CBOR_NON_CANONICAL_VECTORS: readonly string[] = Object.freeze([
  // 23 用一字节形式写成 0x1817。
  "1817",
  // 255 用两字节形式写成 0x1900ff。
  "1900ff",
  // 256 用四字节形式写成 0x1a00000100。
  "1a00000100",
  // 65536 用八字节形式写成 0x1b0000000000010000。
  "1b0000000000010000",
]);