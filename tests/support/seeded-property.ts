/**
 * Seeded property testing (#4271). A property runs on many generated inputs; every input comes
 * from a mulberry32 generator seeded per run, so a failure is reproduced exactly from the seed it
 * names. The default seed and run count are fixed, so an ordinary run is deterministic and never
 * reads the wall clock or `Math.random`. `KEIKO_PROPERTY_SEED` and `KEIKO_PROPERTY_RUNS` override
 * a test's own seed and run count, for a local deep search or to replay one failing case; an
 * invalid value fails the test.
 *
 * A failing input is shrunk greedily through the caller's candidates before it is reported, so a
 * counterexample arrives small enough to become a fixed regression pin.
 */

export interface SeededRandom {
  /** A float in [0, 1). */
  readonly next: () => number;
  /** An integer in [min, max], both inclusive. */
  readonly integer: (min: number, max: number) => number;
  readonly boolean: (probability?: number) => boolean;
  readonly pick: <T>(items: readonly T[]) => T;
  /** A string of [minLength, maxLength] items drawn from `alphabet` (each item one string). */
  readonly string: (alphabet: readonly string[], minLength: number, maxLength: number) => string;
  readonly array: <T>(minLength: number, maxLength: number, item: () => T) => T[];
}

export interface PropertyOptions<T> {
  /** Base seed; run `n` uses a seed derived from it. */
  readonly seed?: number;
  readonly runs?: number;
  /**
   * Smaller inputs to try once an input failed, most aggressive first. A candidate must still be an
   * input the generator could produce; one that fails for another reason misleads the report.
   */
  readonly shrink?: (input: T) => Iterable<T>;
}

const DEFAULT_PROPERTY_SEED = 0x4271;
const DEFAULT_PROPERTY_RUNS = 200;
const MAX_SHRINK_STEPS = 2_000;

/** The code points of `text`, one string each: an alphabet for `SeededRandom.string`. */
export function characters(text: string): string[] {
  return Array.from(text);
}

/** mulberry32: small, fast, full 32-bit period, and identical on every platform. */
export function seededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
  const integer = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new RangeError("pick needs at least one item");
    return items[integer(0, items.length - 1)] as T;
  };
  const array = <T>(minLength: number, maxLength: number, item: () => T): T[] =>
    Array.from({ length: integer(minLength, maxLength) }, item);
  return {
    next,
    integer,
    boolean: (probability = 0.5): boolean => next() < probability,
    pick,
    string: (alphabet, minLength, maxLength): string =>
      array(minLength, maxLength, () => pick(alphabet)).join(""),
    array,
  };
}

/** The seed of one run: reproducible alone, and far from its neighbours. */
export function runSeed(base: number, run: number): number {
  return (base + Math.imul(run, 0x9e3779b9)) >>> 0;
}

function integerSetting(name: string, minimum: number, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer of at least ${String(minimum)}`);
  }
  return value;
}

function settings<T>(options: PropertyOptions<T>): {
  readonly seed: number;
  readonly runs: number;
} {
  return {
    seed: integerSetting("KEIKO_PROPERTY_SEED", 0, options.seed ?? DEFAULT_PROPERTY_SEED),
    runs: integerSetting("KEIKO_PROPERTY_RUNS", 1, options.runs ?? DEFAULT_PROPERTY_RUNS),
  };
}

/** The failure of one input, boxed so that even a thrown `undefined` counts as a failure. */
function failure<T>(
  property: (input: T) => void,
  input: T,
): { readonly error: unknown } | undefined {
  try {
    property(input);
    return undefined;
  } catch (error) {
    return { error };
  }
}

/** Greedy shrinking: take the first smaller candidate that still fails, until none does. */
function shrinkFailure<T>(
  property: (input: T) => void,
  input: T,
  error: unknown,
  shrink: ((input: T) => Iterable<T>) | undefined,
): { readonly input: T; readonly error: unknown } {
  let current = { input, error };
  for (let step = 0; shrink !== undefined && step < MAX_SHRINK_STEPS; step += 1) {
    let smaller: { input: T; error: unknown } | undefined;
    for (const candidate of shrink(current.input)) {
      const candidateFailure = failure(property, candidate);
      if (candidateFailure !== undefined) {
        smaller = { input: candidate, error: candidateFailure.error };
        break;
      }
    }
    if (smaller === undefined) break;
    current = smaller;
  }
  return current;
}

function describeInput(input: unknown): string {
  try {
    // JSON.stringify answers undefined for undefined and functions, despite its declared type.
    const text = JSON.stringify(input) as string | undefined;
    return text ?? String(input);
  } catch {
    return "(input is not serializable)";
  }
}

/** Runs `property` on generated inputs and reports the first failure, shrunk, with its seed. */
export function checkProperty<T>(
  generate: (random: SeededRandom) => T,
  property: (input: T) => void,
  options: PropertyOptions<T> = {},
): void {
  const { seed, runs } = settings(options);
  for (let run = 0; run < runs; run += 1) {
    const caseSeed = runSeed(seed, run);
    const input = generate(seededRandom(caseSeed));
    const observed = failure(property, input);
    if (observed === undefined) continue;
    const shrunk = shrinkFailure(property, input, observed.error, options.shrink);
    const reason = shrunk.error instanceof Error ? shrunk.error.message : String(shrunk.error);
    throw new Error(
      `property failed at run ${String(run)} (case seed ${String(caseSeed)}, base seed ` +
        `${String(seed)}; replay with KEIKO_PROPERTY_SEED=${String(caseSeed)} ` +
        `KEIKO_PROPERTY_RUNS=1) for input ${describeInput(shrunk.input)}: ${reason}`,
      { cause: shrunk.error },
    );
  }
}

/** Shrink candidates for a string: halves first, then each single character removed. */
export function* shrinkString(value: string): Generator<string> {
  const characters = Array.from(value);
  if (characters.length === 0) return;
  const half = Math.floor(characters.length / 2);
  if (half > 0) {
    yield characters.slice(0, half).join("");
    yield characters.slice(half).join("");
  }
  for (let index = 0; index < characters.length; index += 1) {
    yield [...characters.slice(0, index), ...characters.slice(index + 1)].join("");
  }
}

/**
 * Narrows a shrinker to candidates that stay inside the generator's class. A property that holds
 * only for that class would otherwise "fail" on every smaller candidate outside it, and the report
 * would end at a misleading input.
 */
export function shrinkWithin<T>(
  shrink: (input: T) => Iterable<T>,
  keep: (candidate: T) => boolean,
): (input: T) => Generator<T> {
  return function* within(input: T): Generator<T> {
    for (const candidate of shrink(input)) {
      if (keep(candidate)) yield candidate;
    }
  };
}

/** Shrink candidates for an array: halves first, then each single item removed. */
export function* shrinkArray<T>(value: readonly T[]): Generator<T[]> {
  if (value.length === 0) return;
  const half = Math.floor(value.length / 2);
  if (half > 0) {
    yield value.slice(0, half);
    yield value.slice(half);
  }
  for (let index = 0; index < value.length; index += 1) {
    yield [...value.slice(0, index), ...value.slice(index + 1)];
  }
}
