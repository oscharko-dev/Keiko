// Body-free gate for the HTML Manual pilot and release-closure evidence documents (Epic #1858,
// Issue #1904). The pilot runbook and closure-evidence records are the artifacts an operator and a
// release reviewer read; they must never accrue a real leak. This test fails closed if either doc
// ever contains an unambiguous leak signature — a secret, a private/home filesystem path, an HTTP
// cookie header, a token-bearing URL query, or prompt/template scaffolding. Repo-relative paths
// (`docs/…`, `packages/…`), gate commands, and prose that merely names a leak class stay legal, so
// the gate has no false positives on legitimate evidence content.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const EVIDENCE_DOCS = [
  "../../../../docs/qa/html-manual-retrieval-pilot-runbook.md",
  "../../../../docs/qa/html-manual-retrieval-evaluation-evidence.md",
] as const;

// Each pattern is an unambiguous leak SHAPE, not a topic word. Prose that names a class ("cookie",
// "prompt", "token-query") does not match; only the wire/credential/path shape does.
const FORBIDDEN_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  {
    name: "private-or-home-path",
    re: /\/Users\/|\/home\/[a-z]|\/root\/|~\/[A-Za-z.]|[A-Za-z]:\\/u,
  },
  {
    name: "secret-shape",
    re: /sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{12,}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
  },
  { name: "authorization-bearer", re: /Authorization:\s*Bearer\s+\S/iu },
  { name: "cookie-header", re: /(?<![A-Za-z0-9_])(?:set-)?cookie\s*:/iu },
  {
    name: "token-bearing-url",
    re: /[?&](?:access_token|api_key|apikey|auth_token|token|password|secret|client_secret|refresh_token|id_token|session_token)=/iu,
  },
  { name: "prompt-scaffold", re: /<\|im_(?:start|end)\|>|\[\[topic:|\[\/?INST\]|<<\/?SYS>>/iu },
];

function readDoc(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("html-manual pilot & closure evidence stays body-free (#1904)", () => {
  for (const relative of EVIDENCE_DOCS) {
    const name = relative.slice(relative.lastIndexOf("/") + 1);
    it(`${name} exists and is non-empty`, () => {
      expect(readDoc(relative).trim().length).toBeGreaterThan(0);
    });

    for (const { name: patternName, re } of FORBIDDEN_PATTERNS) {
      it(`${name} contains no ${patternName} leak`, () => {
        const match = re.exec(readDoc(relative));
        // Surface the offending fragment (not the whole doc) if this ever regresses.
        expect(match?.[0] ?? null).toBeNull();
      });
    }
  }
});
