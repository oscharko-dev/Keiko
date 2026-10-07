// The Coding Workbench's two limit messages state the hard caps of the operator settings they name
// (#3873 review). The server owns the caps — `configuredRuntimePromptTokenBudget` and
// `configuredRuntimeMaxDurationMinutes` refuse a value above them — and the UI catalogs may not
// import the server, so the numbers in the operator text are pinned against the server's own
// constants here instead of being restated in a second place that could drift: a raised cap that
// left "up to 20,000,000 tokens" in the message would send an operator past the limit into a
// composition failure.
//
// The catalogs are read as text, not imported: keiko-ui is built with its own bundler module
// resolution (no `.js` extensions) and does not type-check under this suite's stricter node16
// tsconfig (see tests/qa/secret-shape-detector-parity.test.ts).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_RUNTIME_MAX_DURATION_MINUTES,
  MAX_RUNTIME_PROMPT_TOKENS,
} from "../../packages/keiko-server/src/coding-runtime/productionRuntimeWorkspaceAuthority.js";

const CATALOG_DIRECTORY =
  "../../packages/keiko-ui/src/app/components/desktop/widgets/coding-workbench";
const EN_CATALOG = `${CATALOG_DIRECTORY}/coding-workbench-i18n.en.ts`;
const DE_CATALOG = `${CATALOG_DIRECTORY}/coding-workbench-i18n.de.ts`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// The string literal a catalog assigns to `key`: a JSON-compatible double-quoted literal.
function catalogMessage(catalog: string, key: string): string {
  const source = readFileSync(fileURLToPath(new URL(catalog, import.meta.url)), "utf8");
  const entry = new RegExp(`"${escapeRegExp(key)}":\\s*("(?:[^"\\\\]|\\\\.)*")`, "u").exec(source);
  if (entry?.[1] === undefined) throw new Error(`catalog entry ${key} not found in ${catalog}`);
  return JSON.parse(entry[1]) as string;
}

describe("Coding Workbench limit messages", () => {
  it("state the server's hard cap of the prompt allowance in both languages", () => {
    const key = "codingWorkbench.event.failure.prompt-allowance-exhausted";
    expect(catalogMessage(EN_CATALOG, key)).toContain(
      `up to ${MAX_RUNTIME_PROMPT_TOKENS.toLocaleString("en-US")} tokens`,
    );
    expect(catalogMessage(DE_CATALOG, key)).toContain(
      `bis höchstens ${MAX_RUNTIME_PROMPT_TOKENS.toLocaleString("de-DE")} Tokens`,
    );
  });

  it("state the server's hard cap of the envelope duration in both languages", () => {
    const key = "codingWorkbench.event.failure.envelope-duration-exhausted";
    expect(catalogMessage(EN_CATALOG, key)).toContain(
      `up to ${MAX_RUNTIME_MAX_DURATION_MINUTES.toLocaleString("en-US")} minutes`,
    );
    expect(catalogMessage(DE_CATALOG, key)).toContain(
      `bis höchstens ${MAX_RUNTIME_MAX_DURATION_MINUTES.toLocaleString("de-DE")} Minuten`,
    );
  });

  it("reads the catalog entry it is asked for and fails loudly for a missing one", () => {
    expect(catalogMessage(EN_CATALOG, "codingWorkbench.event.stopped")).toMatch(
      /^This run was stopped\./u,
    );
    expect(() => catalogMessage(EN_CATALOG, "codingWorkbench.event.does-not-exist")).toThrow(
      /not found/u,
    );
  });
});
