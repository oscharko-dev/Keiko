const UINT32_RANGE = 2 ** 32;
const RANDOM_ID_BYTES = 16;

function secureCrypto(): Crypto {
  const source = globalThis.crypto;
  if (source === undefined) throw new TypeError("secure browser randomness is unavailable");
  return source;
}

function randomHex(source: Crypto): string {
  if (typeof source.getRandomValues !== "function") {
    throw new TypeError("secure browser randomness is unavailable");
  }
  const bytes = new Uint8Array(RANDOM_ID_BYTES);
  source.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function secureRandomId(fallbackPrefix: string): string {
  const source = secureCrypto();
  if (typeof source.randomUUID === "function") return source.randomUUID();
  return `${fallbackPrefix}-${randomHex(source)}`;
}

export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError("maxExclusive must be an integer between 1 and 2^32");
  }
  const source = secureCrypto();
  if (typeof source.getRandomValues !== "function") {
    throw new TypeError("secure browser randomness is unavailable");
  }
  const unbiasedLimit = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive;
  const values = new Uint32Array(1);
  let value: number;
  do {
    source.getRandomValues(values);
    value = values[0] ?? 0;
  } while (value >= unbiasedLimit);
  return value % maxExclusive;
}
