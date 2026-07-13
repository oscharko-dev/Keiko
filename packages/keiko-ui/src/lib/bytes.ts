/** Decode browser base64 into an exact, non-shared buffer suitable for Web APIs. */
export function decodeBase64ArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    // The loop bound guarantees that codePointAt returns a number for every decoded byte.
    bytes[index] = binary.codePointAt(index) as number;
  }
  return buffer;
}

/** Copy an arbitrary typed-array view into a tightly bounded, non-shared buffer. */
export function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
