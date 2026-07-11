import type { IntakeLimits } from "./types.js";

export const DEFAULT_TEST_LIMITS: IntakeLimits = {
  perIdentity: 20,
  global: 1_000,
  concurrency: 16,
  receiptConcurrency: 8,
  openPayloadCount: 10_000,
  openPayloadBytes: 256_000_000,
  proxyHops: 4,
  bodyBytes: 262_144,
  headerBytes: 16_384,
  bodyDeadlineMs: 5_000,
  storageDeadlineMs: 5_000,
};

export function validateIntakeLimits(value: IntakeLimits): IntakeLimits {
  for (const [name, limit] of Object.entries(value)) {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error(`Invalid finite intake limit: ${name}`);
  }
  const bounds: { readonly [Key in keyof IntakeLimits]: readonly [number, number] } = {
    perIdentity: [1, 10_000],
    global: [1, 1_000_000],
    concurrency: [1, 256],
    receiptConcurrency: [1, 255],
    openPayloadCount: [1, 1_000_000],
    openPayloadBytes: [1_024, 1_073_741_824],
    proxyHops: [1, 16],
    bodyBytes: [1_024, 262_144],
    headerBytes: [512, 16_384],
    bodyDeadlineMs: [100, 30_000],
    storageDeadlineMs: [100, 30_000],
  };
  for (const [name, [minimum, maximum]] of Object.entries(bounds)) {
    const limit = value[name as keyof IntakeLimits];
    if (limit < minimum || limit > maximum) throw new Error(`Out-of-range intake limit: ${name}`);
  }
  if (value.concurrency + value.receiptConcurrency > 256) {
    throw new Error("Out-of-range intake pool capacity");
  }
  return Object.freeze({ ...value });
}
