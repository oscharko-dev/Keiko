// Shared argv-parsing primitives for keiko-cli command modules (KEIKO-0655).
//
// `flagValue` was a byte-identical private copy in context.ts, evaluate.ts, gen-tests.ts,
// investigate.ts, and support.ts. `readNamedValueFlags` generalizes the loop structure that was
// itself identical (only the list of flag names varied) behind evaluate.ts's, gen-tests.ts's, and
// investigate.ts's own `readValueFlags`; each of those three keeps a thin local wrapper — its own
// `VALUE_FLAGS` list and its own named return type — that calls straight through to this generic.
//
// `memory.ts` intentionally keeps its own, DIFFERENT `flagValue` and is NOT migrated here: it
// collapses "flag present but missing its value" into `undefined` (same as "flag absent"), rather
// than returning `null` as a distinct usage-error signal. None of memory.ts's call sites branch on
// that distinction today, so migrating it to this null-returning contract would require every call
// site to newly treat "present-without-a-value" as a usage error — a user-visible behavior change
// out of scope for a duplication cleanup. See memory.ts's own `flagValue` for the details.

/**
 * Returns the value of a `--flag value` pair: `undefined` when `name` is absent from `args`,
 * `null` when it is present but missing its value (immediately followed by another `--flag`, or at
 * the end of `args`) — a usage error — or the value string otherwise.
 */
export function flagValue(args: readonly string[], name: string): string | undefined | null {
  const i = args.indexOf(name);
  if (i === -1) {
    return undefined;
  }
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

/**
 * Reads every flag in `flags` via `flagValue`, returning a record keyed by flag name, or `null` if
 * any listed flag is present without a value (a usage error). Generic over the flag-name list so
 * each command module supplies its own `VALUE_FLAGS` and gets back a precisely-keyed record.
 */
export function readNamedValueFlags<K extends string>(
  args: readonly string[],
  flags: readonly K[],
): Record<K, string | undefined> | null {
  const values = {} as Record<K, string | undefined>;
  for (const flag of flags) {
    const value = flagValue(args, flag);
    if (value === null) {
      return null;
    }
    values[flag] = value;
  }
  return values;
}
