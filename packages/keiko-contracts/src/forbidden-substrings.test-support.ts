// KEIKO-0919: shared source-scan lexicon for the redaction pins in voice-action-intent.test.ts
// and voice-session-recap.test.ts (and discussion-intelligence.test.ts). Test-only support module
// — not a runtime export — kept next to the tests that consume it. Extending the shared list
// automatically tightens every pin that references it; a voice-specific extension can still be
// spread on top of the base list at the local site.

export const SHARED_FORBIDDEN_SECRET_VOCABULARY: readonly string[] = [
  "apikey",
  "secret",
  "password",
  "credential",
  "bearer",
  "baseurl",
  "endpoint",
  "authorization",
  "privatekey",
  "accesskey",
  "token",
];
