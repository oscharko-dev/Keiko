// Prompt construction (ADR-0008 D1/D7). Builds the system + user ChatMessage array for the single
// generation call. PURE: no IO, no clock, no randomness — the same inputs always yield the same
// messages. The system message specifies the model-output contract (a fenced ```diff block plus
// optional labeled prose) that parse.ts consumes (steering note B). Context excerpts handed in are
// already redacted by #5; this module does no redaction.

import type { ChatMessage } from "@oscharko-dev/keiko-model-gateway";
import type { ContextPack } from "@oscharko-dev/keiko-workspace";
import type { TestStrategy, TestStyle } from "./frontend.js";
import type { TestConventions, UnitTestTarget, UnitTestWorkflowInput } from "./types.js";

const OUTPUT_CONTRACT =
  "Respond with the unified diff that adds the tests inside a single fenced code block opened " +
  "with ```diff and closed with ```. After the block you MAY add `## Covered behavior` and " +
  "`## Known gaps` sections in prose. Output ONLY a unified diff for test files — never modify " +
  "source files. The first non-empty line inside the fence MUST be `--- /dev/null` for a new " +
  "test file or `--- a/<existing-test-path>` for an existing test file, followed by " +
  "`+++ b/<test-path>` and at least one `@@` hunk. Do not output `*** Begin Patch`, file trees, " +
  "plain prose, markdown bullets, or escaped newline markers like `\\n+`/`\\n-` inside the diff " +
  "fence; every diff line must be separated by a real newline.";

// Per-style discipline (Issue #1203). The output contract is identical for every style — a reviewable
// unified diff for test files — but the test idioms differ by the convention-driven style.
const STYLE_DESCRIPTOR: Readonly<Record<TestStyle, string>> = {
  unit: "rigorous, deterministic unit tests",
  component: "rigorous React component tests",
  interaction: "rigorous React component interaction tests",
  "accessibility-smoke": "rigorous React component tests with an accessibility smoke check",
  "browser-smoke": "a minimal Playwright browser smoke test",
  unsupported: "unit tests",
};

const STYLE_GUIDANCE: Readonly<Record<TestStyle, readonly string[]>> = {
  unit: [
    "Cover edge cases explicitly: null, undefined, empty, zero, boundary, negative, and error paths.",
  ],
  component: [
    "Render the component with @testing-library/react render(), query through screen by accessible " +
      "role/name or visible text, and assert user-visible output. Do not assert implementation details " +
      "or internal state. Cover empty, loading, and error states where the component supports them.",
  ],
  interaction: [
    "Render the component with @testing-library/react, drive interactions with @testing-library/" +
      "user-event (const user = userEvent.setup(); await user.click(...) / user.type(...)), and assert " +
      "the resulting accessible UI changes. Do not assert internal state.",
  ],
  "accessibility-smoke": [
    "Render the component with @testing-library/react and query by accessible role/name so the test " +
      "exercises the accessibility tree. Include at least one accessibility assertion: where the project " +
      "provides an axe matcher, assert the rendered output has no detectable accessibility violations.",
  ],
  "browser-smoke": [
    'Write a minimal Playwright browser smoke test: import { test, expect } from "@playwright/test", ' +
      "navigate to the route under test, and assert that one key user-visible element is visible. Keep " +
      "it a happy-path smoke test, not an exhaustive suite. Place it under the project's end-to-end test " +
      "directory.",
  ],
  unsupported: [],
};

function systemContent(conventions: TestConventions, strategy: TestStrategy): string {
  const lines = [
    `You are a senior engineer writing ${STYLE_DESCRIPTOR[strategy.style]} for existing code.`,
    `Test framework: ${conventions.framework}.`,
    `Place new tests using the project's "${conventions.fileNamingStyle}" naming convention.`,
    conventions.testDirs.length > 0
      ? `Project test directories: ${conventions.testDirs.join(", ")}.`
      : "No dedicated test directory detected; place tests beside their source.",
    ...STYLE_GUIDANCE[strategy.style],
    OUTPUT_CONTRACT,
  ];
  return `${lines.join("\n")}${assertionStyleBlock(conventions)}`;
}

function assertionStyleBlock(conventions: TestConventions): string {
  if (conventions.assertionStyleSamples.length === 0) {
    return "";
  }
  const samples = conventions.assertionStyleSamples
    .map((sample, idx) => `Example test ${String(idx + 1)}:\n${sample}`)
    .join("\n\n");
  return `\n\nMatch the assertion and structure style of these existing tests:\n${samples}`;
}

function targetDescription(target: UnitTestTarget): string {
  if (target.kind === "file") {
    return target.targetFunction === undefined
      ? `Write unit tests for the public API in ${target.filePath}.`
      : `Write unit tests for the function ${target.targetFunction} in ${target.filePath}.`;
  }
  if (target.kind === "module") {
    return `Write unit tests for the source files in the module directory ${target.moduleDir}.`;
  }
  return `Write unit tests for these changed files: ${target.filePaths.join(", ")}.`;
}

function contextBlock(pack: ContextPack): string {
  if (pack.selected.length === 0) {
    return "";
  }
  const entries = pack.selected
    .map((entry) => `--- ${entry.path} ---\n${entry.excerpt}`)
    .join("\n\n");
  return `\n\nRepository context:\n${entries}`;
}

function userContent(
  input: UnitTestWorkflowInput,
  pack: ContextPack,
  rejectionReason: string | undefined,
): string {
  const retry =
    rejectionReason === undefined
      ? ""
      : `\n\nThe previous diff was rejected: ${rejectionReason}. Produce a corrected diff that ` +
        "modifies ONLY test files.";
  return `${targetDescription(input.target)}${contextBlock(pack)}${retry}`;
}

// rejectionReason is appended on a retry (D8) so the model can correct an invalid/out-of-scope
// diff; it is undefined on the first attempt. The core signature is (input, conventions, strategy,
// pack); the optional 5th argument carries retry state without breaking that contract. The strategy
// (Issue #1203) drives the per-style test idioms in the system message.
export function buildPrompt(
  input: UnitTestWorkflowInput,
  conventions: TestConventions,
  strategy: TestStrategy,
  pack: ContextPack,
  rejectionReason?: string,
): readonly ChatMessage[] {
  return [
    { role: "system", content: systemContent(conventions, strategy) },
    { role: "user", content: userContent(input, pack, rejectionReason) },
  ];
}
