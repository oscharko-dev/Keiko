/**
 * SHA-256 (FIPS 180-4) without a platform dependency.
 *
 * Contract modules are loaded by the server and by the browser bundle alike. A module that imports
 * `node:crypto` cannot be bundled for the browser, even when the browser never calls the hashing
 * function (#4354: the template binding digest broke the UI build that way). Digests computed in a
 * contract module therefore use this implementation. It returns exactly what
 * `createHash("sha256").update(text, "utf8").digest("hex")` returns; the test compares the two.
 */
const ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const INITIAL_STATE: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** The message with its padding and bit length, as big-endian 32-bit words. */
function paddedWords(bytes: Uint8Array): Uint32Array {
  const totalBytes = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(totalBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, Math.floor((bytes.length * 8) / 0x100000000), false);
  view.setUint32(totalBytes - 4, (bytes.length * 8) >>> 0, false);
  const words = new Uint32Array(totalBytes / 4);
  for (let index = 0; index < words.length; index += 1) {
    words[index] = view.getUint32(index * 4, false);
  }
  return words;
}

/** The 64-word message schedule of the block that starts at `offset`. */
function messageSchedule(words: Uint32Array, offset: number): Uint32Array {
  const schedule = new Uint32Array(64);
  for (let index = 0; index < 16; index += 1) schedule[index] = words[offset + index] ?? 0;
  for (let index = 16; index < 64; index += 1) {
    const w15 = schedule[index - 15] ?? 0;
    const w2 = schedule[index - 2] ?? 0;
    const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
    const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
    schedule[index] = (schedule[index - 16] ?? 0) + sigma0 + (schedule[index - 7] ?? 0) + sigma1;
  }
  return schedule;
}

/** One round: the working variables `[a..h]` after mixing in one schedule word. */
function round(working: readonly number[], constant: number, word: number): number[] {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = working;
  const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
  const choice = (e & f) ^ (~e & g);
  const temp1 = (h + sum1 + choice + constant + word) >>> 0;
  const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
  const majority = (a & b) ^ (a & c) ^ (b & c);
  const temp2 = (sum0 + majority) >>> 0;
  return [(temp1 + temp2) >>> 0, a, b, c, (d + temp1) >>> 0, e, f, g];
}

function compress(state: Uint32Array, schedule: Uint32Array): void {
  let working: number[] = Array.from(state);
  for (let index = 0; index < 64; index += 1) {
    working = round(working, ROUND_CONSTANTS[index] ?? 0, schedule[index] ?? 0);
  }
  for (let index = 0; index < 8; index += 1) {
    state[index] = (state[index] ?? 0) + (working[index] ?? 0);
  }
}

/** The SHA-256 digest of the UTF-8 encoding of `text`, as 64 lower-case hex characters. */
export function portableSha256Hex(text: string): string {
  const words = paddedWords(new TextEncoder().encode(text));
  const state = Uint32Array.from(INITIAL_STATE);
  for (let offset = 0; offset < words.length; offset += 16) {
    compress(state, messageSchedule(words, offset));
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}
