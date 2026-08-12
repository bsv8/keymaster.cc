import type { BinaryField } from "@keymaster/contracts/connect-public";

/** Wraps bytes in the explicit binary field required by Connect V1. */
export function binary(bytes: ArrayBuffer | ArrayBufferView, mime?: string): BinaryField {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return {
    $type: "binary",
    bytes: copy.buffer,
    ...(mime ? { mime } : {})
  };
}

/** Returns an immutable byte copy of a Connect binary field. */
export function binaryBytes(field: BinaryField): Uint8Array {
  if (field.$type !== "binary" || !(field.bytes instanceof ArrayBuffer)) {
    throw new TypeError("Expected a Keymaster BinaryField");
  }
  return new Uint8Array(field.bytes.slice(0));
}

/** Encodes UTF-8 text as a Connect binary field. */
export function binaryText(value: string, mime = "text/plain;charset=utf-8"): BinaryField {
  return binary(new TextEncoder().encode(value), mime);
}

/** Decodes a Connect binary field as UTF-8 text. */
export function binaryToText(field: BinaryField): string {
  return new TextDecoder().decode(binaryBytes(field));
}
