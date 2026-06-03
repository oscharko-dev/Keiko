// Centralised secret-collection helpers used by the BFF, CLI, and evaluation entrypoints to feed
// `createAuditRedactor` with the exact apiKey values held in the environment. Pure functions: no
// IO, no logging, no dependency on UI/CLI/gateway shapes. Consumers compose these with their own
// config secrets (provider apiKey values) before calling the redactor builder.
//
// Why these helpers exist here, not in each caller: prior to extraction the BFF and the CLI
// evaluator carried byte-identical copies of `isKeikoApiKeyEnvName` and the env-walk that fed
// `redactionSecrets`/`keikoApiKeySecrets` — a single behavioural drift would have left one
// surface less protected than the other (AC #1: no API token newly exposed). Centralising the
// detector and the collector keeps every caller scrubbing the same names.

// A read-only view over process.env. Values may be `undefined` when the key is not set.
export type EnvSource = Readonly<Record<string, string | undefined>>;

// Returns true iff `name` matches the conventional KEIKO env-var shape that carries a model
// provider API key:
//   - KEIKO_DEFAULT_API_KEY  (the fallback used when no per-model key is set)
//   - KEIKO_MODEL_<id>_API_KEY  (per-model override; <id> is opaque to this helper)
//
// The match is exact prefix + exact suffix to avoid false positives (e.g. "KEIKO_API_KEY_NOTE"
// would not match because of the missing "_MODEL_" segment).
export function isKeikoApiKeyEnvName(name: string): boolean {
  return (
    name === "KEIKO_DEFAULT_API_KEY" ||
    (name.startsWith("KEIKO_MODEL_") && name.endsWith("_API_KEY"))
  );
}

// Collects the VALUES of every env entry whose name is a KEIKO API-key env var. Undefined and
// empty values are skipped — feeding "" to the redactor would over-redact ordinary text. Names
// are never collected, only values: redacting a name like "KEIKO_DEFAULT_API_KEY" in a log line
// would obscure debugging output without protecting any secret.
export function keikoApiKeySecretValues(env: EnvSource): readonly string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length > 0 && isKeikoApiKeyEnvName(name)) {
      values.push(value);
    }
  }
  return values;
}
