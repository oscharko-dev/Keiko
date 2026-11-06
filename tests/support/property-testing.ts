// Seeded property testing for Keiko's pure text rules, without a third-party dependency.
//
// A property states what must hold for every input; the harness draws inputs from a seeded
// generator, and on the first failure shrinks the input to a small counterexample and reports how
// to replay it. Everything is deterministic: a fixed seed per property, a fixed run count, and a
// pseudo-random generator that reads only its own state (sfc32, seeded through splitmix32). A run
// can be widened locally or nightly through two variables, never silently:
//
//   KEIKO_PROPERTY_SEED=<uint32>  replays one base seed (the failure message prints it)
//   KEIKO_PROPERTY_RUNS=<count>   overrides every property's run count
//
// Invalid values fail the run instead of falling back, so a typo cannot pass for a deep run.

export interface Random {
  // A float in [0, 1).
  readonly next: () => number;
  // An integer in [min, max], both inclusive.
  readonly integer: (min: number, max: number) => number;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly chance: (probability: number) => boolean;
}

export type Generator<T> = (random: Random) => T;
export type Shrinker<T> = (value: T) => Iterable<T>;

export interface PropertyOptions<T> {
  readonly name: string;
  readonly generate: Generator<T>;
  // Throws (or rejects) when the property does not hold for `value`.
  readonly property: (value: T) => void | Promise<void>;
  readonly shrink?: Shrinker<T>;
  readonly runs?: number;
  readonly seed?: number;
}

const DEFAULT_RUNS = 200;
// Each candidate is one property evaluation; the budget keeps a shrink of a slow input bounded.
const SHRINK_EVALUATIONS_MAX = 400;
const UINT32 = 0x1_0000_0000;

function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x9e3779b9) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b);
    mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);
    return (mixed ^ (mixed >>> 16)) >>> 0;
  };
}

function sfc32(seed: number): () => number {
  const init = splitmix32(seed);
  let a = init();
  let b = init();
  let c = init();
  let d = init();
  return (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / UINT32;
  };
}

export function createRandom(seed: number): Random {
  const next = sfc32(seed);
  const integer = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new RangeError("integer() needs integer bounds with min <= max.");
    }
    return min + Math.floor(next() * (max - min + 1));
  };
  return {
    next,
    integer,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new RangeError("pick() needs at least one item.");
      return items[integer(0, items.length - 1)] as T;
    },
    chance: (probability: number): boolean => next() < probability,
  };
}

// A stable default seed per property name, so two properties never share an input sequence.
export function seedOf(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function caseSeed(base: number, index: number): number {
  return splitmix32(base ^ Math.imul(index + 1, 0x9e3779b9))();
}

function integerFromEnv(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = /^\d{1,10}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max)) {
    throw new RangeError(`${name} must be an integer between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

export function propertySettings(options: {
  readonly name: string;
  readonly runs?: number;
  readonly seed?: number;
}): { readonly seed: number; readonly runs: number } {
  const seed = integerFromEnv("KEIKO_PROPERTY_SEED", 0, UINT32 - 1) ?? options.seed;
  const runs = integerFromEnv("KEIKO_PROPERTY_RUNS", 1, 1_000_000) ?? options.runs;
  return { seed: seed ?? seedOf(options.name), runs: runs ?? DEFAULT_RUNS };
}

async function failure<T>(property: PropertyOptions<T>["property"], value: T): Promise<unknown> {
  try {
    await property(value);
    return undefined;
  } catch (error: unknown) {
    return error ?? new Error("The property threw a nullish value.");
  }
}

interface Counterexample<T> {
  readonly value: T;
  readonly error: unknown;
  readonly steps: number;
}

async function shrunk<T>(
  options: PropertyOptions<T>,
  start: Counterexample<T>,
): Promise<Counterexample<T>> {
  let current = start;
  let evaluations = 0;
  let improved = options.shrink !== undefined;
  while (improved && evaluations < SHRINK_EVALUATIONS_MAX) {
    improved = false;
    for (const candidate of options.shrink?.(current.value) ?? []) {
      if (evaluations >= SHRINK_EVALUATIONS_MAX) break;
      evaluations += 1;
      const error = await failure(options.property, candidate);
      if (error === undefined) continue;
      current = { value: candidate, error, steps: current.steps + 1 };
      improved = true;
      break;
    }
  }
  return current;
}

function describeValue(value: unknown): string {
  // JSON escapes lone surrogates and control characters, so the counterexample can be pasted back.
  const text = JSON.stringify(value);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}… (${String(text.length)} chars)` : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function checkProperty<T>(options: PropertyOptions<T>): Promise<void> {
  const { seed, runs } = propertySettings(options);
  for (let index = 0; index < runs; index += 1) {
    const value = options.generate(createRandom(caseSeed(seed, index)));
    const error = await failure(options.property, value);
    if (error === undefined) continue;
    const minimal = await shrunk(options, { value, error, steps: 0 });
    throw new Error(
      [
        `Property "${options.name}" failed on case ${String(index + 1)} of ${String(runs)}.`,
        `Replay: KEIKO_PROPERTY_SEED=${String(seed)} (shrunk in ${String(minimal.steps)} steps)`,
        `Counterexample: ${describeValue(minimal.value)}`,
        `Cause: ${messageOf(minimal.error)}`,
      ].join("\n"),
      { cause: minimal.error },
    );
  }
}

// ─── Generators ──────────────────────────────────────────────────────────────

export function arrayOf<T>(item: Generator<T>, min: number, max: number): Generator<T[]> {
  return (random) => Array.from({ length: random.integer(min, max) }, () => item(random));
}

export function oneOf<T>(...generators: readonly Generator<T>[]): Generator<T> {
  return (random) => random.pick(generators)(random);
}

// Characters that broke or slowed text rules before: astral letters, combining marks (including
// the ypogegrammeni), the long s and dotted capital I, ligatures, lone surrogates, NUL and control
// characters, bidi controls, zero-width joiners and every kind of space or line break.
const EDGE_CHARACTERS: readonly string[] = [
  "𠀀",
  "😀",
  "𝐀",
  "́",
  "ͅ",
  "ſ",
  "İ",
  "ı",
  "ß",
  "ẞ",
  "ﬁ",
  "\ud800",
  "\udfff",
  "\u0000",
  "\u0007",
  "‮",
  "‏",
  "‍",
  "​",
  " ",
  " ",
  "　",
  "\r",
  "\n",
  "\t",
  "ä",
  "Ö",
  "é",
  "ñ",
  "Ω",
  "я",
  "中",
  "ا",
  "'",
  "’",
  '"',
  "„",
  "“",
  "«",
  "»",
  ".",
  ",",
  ":",
  ";",
  "!",
  "?",
  "-",
  "–",
  "—",
  "(",
  ")",
  "/",
  "\\",
  "@",
  "#",
  "=",
  "&",
];

export const unicodeCharacter: Generator<string> = (random) => {
  if (random.chance(0.35)) return random.pick(EDGE_CHARACTERS);
  if (random.chance(0.7)) return String.fromCharCode(random.integer(0x20, 0x7e));
  return String.fromCodePoint(random.integer(0x00a0, 0x2fff));
};

export function unicodeString(maxLength: number): Generator<string> {
  return (random) => arrayOf(unicodeCharacter, 0, maxLength)(random).join("");
}

// Joins words with the separators people type, including none at all.
export function textOf(words: Generator<string>, min: number, max: number): Generator<string> {
  const separators = [" ", " ", " ", ", ", ". ", "\n", "", "  ", " — "];
  return (random) =>
    arrayOf(
      words,
      min,
      max,
    )(random)
      .map((word) => `${word}${random.pick(separators)}`)
      .join("")
      .trimEnd();
}

// ─── Shrinkers ───────────────────────────────────────────────────────────────

// Removes ever smaller runs of code points, so a counterexample keeps whole characters.
export function* shrinkString(value: string): Iterable<string> {
  const points = Array.from(value);
  if (points.length === 0) return;
  yield "";
  for (let size = Math.floor(points.length / 2); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= points.length; start += size) {
      yield [...points.slice(0, start), ...points.slice(start + size)].join("");
    }
  }
}

export function* shrinkArray<T>(values: readonly T[], item?: Shrinker<T>): Iterable<T[]> {
  for (let index = 0; index < values.length; index += 1) {
    yield values.filter((_, at) => at !== index);
  }
  if (item === undefined) return;
  for (let index = 0; index < values.length; index += 1) {
    for (const smaller of item(values[index] as T)) {
      yield values.map((value, at) => (at === index ? smaller : value));
    }
  }
}

export type FieldShrinkers<T> = { readonly [K in keyof T]?: Shrinker<T[K]> };

// Shrinks one field at a time and keeps the others, so every candidate stays a valid record.
export function shrinkRecord<T extends object>(fields: FieldShrinkers<T>): Shrinker<T> {
  return function* shrinkFields(value: T): Iterable<T> {
    for (const key of Object.keys(fields) as (keyof T)[]) {
      const shrinkField = fields[key];
      if (shrinkField === undefined) continue;
      for (const smaller of shrinkField(value[key])) yield { ...value, [key]: smaller };
    }
  };
}

// ─── Scaling ─────────────────────────────────────────────────────────────────

export interface ScalingOptions {
  readonly build: (size: number) => string;
  readonly run: (input: string) => unknown;
  // The first size tried; it grows fourfold until the small run takes `minimumMs`.
  readonly size: number;
  readonly maximumSize: number;
  readonly minimumMs?: number;
}

export interface Scaling {
  readonly size: number;
  // Median milliseconds of three runs at `size` and at four times `size`.
  readonly smallMs: number;
  readonly largeMs: number;
  // False when even the largest small size ran faster than timer noise allows to compare.
  readonly measurable: boolean;
}

export const SCALING_FACTOR = 4;

function medianMs(run: () => unknown): number {
  const times = [0, 1, 2].map(() => {
    const started = performance.now();
    run();
    return performance.now() - started;
  });
  return times.sort((a, b) => a - b)[1] ?? 0;
}

// Builds the input first, so only the rule's own work is timed.
function timedAt(options: ScalingOptions, size: number): number {
  const input = options.build(size);
  return medianMs(() => options.run(input));
}

// Compares running times at two sizes instead of trusting one absolute time: a linear rule grows
// by the size factor, a quadratic one by its square, whatever the machine's speed or load. A rule
// too fast to time at the first size is timed again on larger inputs, so a quadratic path cannot
// pass merely because it is still quick on a small input.
export function measureScaling(options: ScalingOptions): Scaling {
  const minimumMs = options.minimumMs ?? 5;
  options.run(options.build(Math.max(1, Math.floor(options.size / 10))));
  let size = options.size;
  let smallMs = timedAt(options, size);
  while (smallMs < minimumMs && size * SCALING_FACTOR <= options.maximumSize) {
    size *= SCALING_FACTOR;
    smallMs = timedAt(options, size);
  }
  const largeMs = timedAt(options, size * SCALING_FACTOR);
  return { size, smallMs, largeMs, measurable: smallMs >= minimumMs };
}
