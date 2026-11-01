// Arguments of the offline review gate (Issue #4138). Every run names its set, its variant, the
// exact model pair and where its evidence goes; a development run also names its iteration and the
// pull requests whose labels informed its configuration. The holdout run needs an explicit
// confirmation flag because it may happen exactly once (ADR-0182 D9).

export const GATE_SETS = ["development", "holdout", "seeds"] as const;
export type GateSet = (typeof GATE_SETS)[number];

export const GATE_VARIANTS = ["product", "roles-swapped", "counter-check-off"] as const;
export type GateVariant = (typeof GATE_VARIANTS)[number];

export interface GateArguments {
  readonly set: GateSet;
  readonly variant: GateVariant;
  readonly repository: string;
  readonly configPath: string;
  readonly stateDir: string;
  readonly outDir: string;
  readonly reviewerModelId: string;
  readonly counterCheckerModelId: string;
  readonly iteration: string;
  readonly sampleSize: number;
  readonly pullRequests: readonly number[] | undefined;
  readonly tuningInputs: readonly number[];
  readonly port: number;
}

export class GateArgumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GateArgumentError";
  }
}

const DEFAULT_SAMPLE_SIZE = 30;
const DEFAULT_PORT = 1995;

function flagValues(argv: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (!flag.startsWith("--")) throw new GateArgumentError(`unexpected argument: ${flag}`);
    if (flag === "--confirm-final-holdout") {
      values.set(flag, "true");
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new GateArgumentError(`${flag} needs a value`);
    }
    values.set(flag, value);
    index += 1;
  }
  return values;
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined || value.trim() === "")
    throw new GateArgumentError(`${flag} is required`);
  return value;
}

function oneOf<const T extends string>(value: string, allowed: readonly T[], flag: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined)
    throw new GateArgumentError(`${flag} must be one of ${allowed.join(", ")}`);
  return match;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new GateArgumentError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function numberList(value: string | undefined, flag: string): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === "") return [];
  return value.split(",").map((part) => positiveInteger(part.trim(), flag));
}

function checkSetRules(
  values: ReadonlyMap<string, string>,
  set: GateSet,
  variant: GateVariant,
): void {
  if (set === "holdout" && values.get("--confirm-final-holdout") !== "true") {
    throw new GateArgumentError("the holdout runs exactly once: pass --confirm-final-holdout");
  }
  if (set !== "development" && variant !== "product") {
    throw new GateArgumentError("variants are measured on the development set only");
  }
  if (set !== "development" && values.has("--tuning-inputs")) {
    throw new GateArgumentError("--tuning-inputs belongs to a development run");
  }
}

/** Parses and validates the gate's arguments; throws `GateArgumentError` on any violation. */
export function parseGateArguments(argv: readonly string[]): GateArguments {
  const values = flagValues(argv);
  const set = oneOf(required(values, "--set"), GATE_SETS, "--set");
  const variant = oneOf(values.get("--variant") ?? "product", GATE_VARIANTS, "--variant");
  checkSetRules(values, set, variant);
  return {
    set,
    variant,
    repository: required(values, "--repository"),
    configPath: required(values, "--config"),
    stateDir: required(values, "--state"),
    outDir: required(values, "--out"),
    reviewerModelId: required(values, "--reviewer"),
    counterCheckerModelId: required(values, "--counter-checker"),
    iteration: set === "development" ? required(values, "--iteration") : set,
    sampleSize: positiveInteger(values.get("--sample") ?? String(DEFAULT_SAMPLE_SIZE), "--sample"),
    pullRequests: numberList(values.get("--pull-requests"), "--pull-requests"),
    tuningInputs: numberList(values.get("--tuning-inputs"), "--tuning-inputs") ?? [],
    port: positiveInteger(values.get("--port") ?? String(DEFAULT_PORT), "--port"),
  };
}
