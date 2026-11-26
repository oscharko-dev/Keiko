/** The reasons the evidence does not certify the promise; empty when it does. */
export function acceptanceEvidenceFailures(
  evidence: unknown,
  options?: { readonly preconditionsOnly?: boolean },
): string[];

/** One body-free line per fact. */
export function acceptanceEvidenceSummary(evidence: unknown): string[];

/** Reads the evidence named by `argv[2]` and returns the process exit code. */
export function runCheck(
  argv: readonly string[],
  io?: {
    readonly log: (line: string) => void;
    readonly error: (line: string) => void;
  },
): number;
