// Fixture data consumed by TypeScript scenario tests. Executable gate logic stays in the .mjs owner.
export const INCIDENT_FEATURE_PATH: string;
export const INCIDENT_TEST_PATH: string;
export const INCIDENT_RETRIEVAL_FILES: Readonly<Record<string, string>>;
export const INCIDENT_RETRIEVAL_CASES: readonly {
  readonly id: string;
  readonly query: string;
  readonly expectedTop: string;
}[];
