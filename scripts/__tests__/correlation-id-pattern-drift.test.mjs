// #2902 audit finding 2: `install-client-diagnostics.ts` (keiko-ui) hand-copies the server's
// `SAFE_CORRELATION_ID` regex byte-for-byte as its own `CLIENT_CORRELATION_ID_PATTERN` constant,
// because keiko-ui may only depend on the server through the shared contract types (AGENTS.md §4),
// never on a server module directly — so it cannot import the server's declaration the way
// ERROR_KIND_PATTERN was consolidated into `keiko-contracts` (ADR-0173 D11). Relocating this
// pattern into the leaf would conflict with the deliberate, already-documented layering decision in
// `packages/keiko-contracts/src/diagnostics.ts` (the wire-shape guard there intentionally stays
// LOOSER than SAFE_CORRELATION_ID so the leaf never imports server policy) — `install-client-
// diagnostics.ts`'s own header cites that file as precedent for keeping its own copy. So unlike
// ERROR_KIND_PATTERN, this is not consolidated into one declaration; it stays two independent,
// differently-scoped declarations by design (server policy vs. client-side best-effort pre-filter).
//
// What WAS missing is drift protection: no test anywhere referenced either constant name, so
// either literal could be edited alone (e.g. widening the UI copy's length bound) and the full
// suite would stay green — nothing would catch the divergence. This is the weaker of the two
// techniques already used in this repo (a two-file byte-for-byte diff, not a single-declaration
// repo-wide scan) because there legitimately are two declarations here; a single-source-of-truth
// assertion would be the wrong pin to write for this pair.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const SERVER_FILE = "packages/keiko-server/src/correlation.ts";
const CLIENT_FILE = "packages/keiko-ui/src/lib/install-client-diagnostics.ts";

// Extracts the regex literal assigned to `constantName` from `source`, e.g. given
// `const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{8,128}$/;` and `"SAFE_CORRELATION_ID"`, returns
// `"/^[A-Za-z0-9._-]{8,128}$/"` — the literal text, not a compiled RegExp, so the comparison below
// is character-for-character and trips on a widened character class or changed length bound even
// if the two patterns would still accept/reject the same handful of test strings.
function extractRegexLiteral(source, constantName) {
  const pattern = new RegExp(`\\b${constantName}\\s*=\\s*(\\/[^\\n]*\\/)`);
  const match = pattern.exec(source);
  if (match === null) {
    throw new Error(`could not find a declaration of ${constantName} in the given source`);
  }
  return match[1];
}

describe("client/server correlation-id pattern drift (#2902 audit finding 2)", () => {
  it("keeps CLIENT_CORRELATION_ID_PATTERN character-for-character identical to SAFE_CORRELATION_ID", () => {
    const serverSource = readFileSync(resolve(REPO_ROOT, SERVER_FILE), "utf8");
    const clientSource = readFileSync(resolve(REPO_ROOT, CLIENT_FILE), "utf8");

    const serverLiteral = extractRegexLiteral(serverSource, "SAFE_CORRELATION_ID");
    const clientLiteral = extractRegexLiteral(clientSource, "CLIENT_CORRELATION_ID_PATTERN");

    expect(clientLiteral).toBe(serverLiteral);
  });
});
