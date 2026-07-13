function isAsciiAlphaNumeric(character: string): boolean {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSafeScriptCharacter(character: string): boolean {
  return (
    isAsciiAlphaNumeric(character) ||
    character === "." ||
    character === "_" ||
    character === ":" ||
    character === "-"
  );
}

function everyCharacter(value: string, predicate: (character: string) => boolean): boolean {
  for (const character of value) {
    if (!predicate(character)) return false;
  }
  return true;
}

function isSafeScriptName(value: string): boolean {
  const normalized = value.normalize();
  const first = normalized.at(0);
  return (
    first !== undefined &&
    isAsciiAlphaNumeric(first) &&
    everyCharacter(normalized, isSafeScriptCharacter)
  );
}

export type ClosedDebugExecution =
  | {
      readonly kind: "file";
      readonly executable: string;
      readonly args: readonly string[];
      readonly target: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "catalog";
      readonly executable: string;
      readonly args: readonly string[];
      readonly scriptName: string;
      readonly shell: string;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    };

export interface DebugLaunchPolicy {
  readonly nodeExecutable: string;
  readonly npmExecutable: string;
  readonly shellExecutable: string;
  readonly npmUserConfig: string;
  readonly npmGlobalConfig: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly layer1Allowed: (executable: string, args: readonly string[]) => boolean;
}

export interface DebugLaunchPolicyDecision {
  readonly allowed: boolean;
  readonly reason?: "STRUCTURE_DRIFT" | "LAYER1_DENIED" | undefined;
}

function sameRecord(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => Object.hasOwn(expected, key) && actual[key] === expected[key])
  );
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function expectedArgs(
  execution: Extract<ClosedDebugExecution, { readonly kind: "catalog" }>,
  policy: DebugLaunchPolicy,
): readonly string[] {
  return [
    "--ignore-scripts",
    `--script-shell=${policy.shellExecutable}`,
    `--userconfig=${policy.npmUserConfig}`,
    `--globalconfig=${policy.npmGlobalConfig}`,
    "--location=global",
    "run",
    execution.scriptName,
  ];
}

function structureAllowed(execution: ClosedDebugExecution, policy: DebugLaunchPolicy): boolean {
  if (execution.cwd !== policy.cwd || !sameRecord(execution.env, policy.env)) return false;
  if (execution.kind === "file") {
    return (
      execution.executable === policy.nodeExecutable && sameArgs(execution.args, [execution.target])
    );
  }
  return (
    execution.executable === policy.npmExecutable &&
    execution.shell === policy.shellExecutable &&
    isSafeScriptName(execution.scriptName) &&
    sameArgs(execution.args, expectedArgs(execution, policy))
  );
}

export function validateDebugLaunchPolicy(
  execution: ClosedDebugExecution,
  policy: DebugLaunchPolicy,
): DebugLaunchPolicyDecision {
  if (!structureAllowed(execution, policy)) return { allowed: false, reason: "STRUCTURE_DRIFT" };
  if (!policy.layer1Allowed(execution.executable, execution.args)) {
    return { allowed: false, reason: "LAYER1_DENIED" };
  }
  return { allowed: true };
}
