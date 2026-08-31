// Pure pins for the model-complete buffer source used by the replacement postcondition (PR #3355
// review, P2). The live Chromium journey below the helper exercises request observation; these
// fixtures prove its parser preserves whitespace and off-screen content instead of falling back to
// Monaco's virtualized rendered lines.
import type { Page, Request } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  editorModifier,
  hotExitSnapshotContent,
  isExactHotExitWrite,
  matchesExactHotExitSnapshot,
  type ExactHotExitExpectation,
} from "./editor-chord.js";

// `editorModifier`'s "Meta" branch is dead under every currently-wired device profile — both the
// chromium and firefox projects in playwright.config.ts force a Windows user agent, so nothing in
// the live suite ever exercises it, and a typo in the callback ("macOS" instead of "Macintosh")
// would pass every real run silently (PR #3355 review, IDX45). This exercises both branches
// directly against a fake `Page` whose `evaluate()` runs editorModifier's REAL browser-side
// callback against a stubbed global `navigator`, rather than re-deriving the substring check here
// — a re-derived fixture could not catch a typo in the production callback because both sides
// would drift together (AGENTS.md §7).
function fakePageWithUserAgent(userAgent: string): Page {
  return {
    evaluate: <T>(pageFunction: () => T) => {
      vi.stubGlobal("navigator", { userAgent });
      return Promise.resolve(pageFunction());
    },
  } as unknown as Page;
}

describe("editorModifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves "Meta" when the browser reports a Macintosh user agent', async () => {
    const page = fakePageWithUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    await expect(editorModifier(page)).resolves.toBe("Meta");
  });

  it('resolves "Control" for a non-Macintosh user agent (this suite\'s forced Windows UA)', async () => {
    const page = fakePageWithUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );
    await expect(editorModifier(page)).resolves.toBe("Control");
  });
});

describe("hotExitSnapshotContent", () => {
  it("reads the production hot-exit request shape", () => {
    const content = 'export const value = "new";\n';
    expect(hotExitSnapshotContent({ snapshot: { content } })).toBe(content);
  });

  it("preserves whitespace exactly instead of trimming model content", () => {
    const content = "\t  return value;  \n";
    const observed = hotExitSnapshotContent({ snapshot: { content } });
    expect(observed).toBe(content);
    expect(observed).not.toBe(content.trim());
  });

  it("reads every off-screen line instead of Monaco's virtualized DOM subset", () => {
    const content = Array.from(
      { length: 200 },
      (_value, index) => `export const line${String(index)} = ${String(index)};`,
    ).join("\n");
    expect(hotExitSnapshotContent({ snapshot: { content } })).toBe(content);
    expect(
      hotExitSnapshotContent({
        snapshot: { content: content.split("\n").slice(0, 20).join("\n") },
      }),
    ).not.toBe(content);
  });

  it.each([
    undefined,
    null,
    {},
    { snapshot: null },
    { snapshot: {} },
    { snapshot: { content: 1 } },
  ])("rejects a payload without a string snapshot content field (%j)", (payload) => {
    expect(hotExitSnapshotContent(payload)).toBeUndefined();
  });
});

const EXACT_EXPECTATION: ExactHotExitExpectation = {
  content: "export function value(): number {\n  return 1;\n}\n",
  paneId: "pane-1",
  relativePath: "src/value.ts",
  windowId: "editor-pane-1",
  workspaceRoot: "/workspace/exact",
};

function hotExitPayload(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    snapshot: {
      content: EXACT_EXPECTATION.content,
      paneId: EXACT_EXPECTATION.paneId,
      relativePath: EXACT_EXPECTATION.relativePath,
      windowId: EXACT_EXPECTATION.windowId,
      workspaceRoot: EXACT_EXPECTATION.workspaceRoot,
      ...overrides,
    },
  };
}

function fakeRequest(
  options: {
    readonly method?: string;
    readonly payload?: unknown;
    readonly throws?: boolean;
    readonly url?: string;
  } = {},
): Request {
  return {
    method: () => options.method ?? "POST",
    postDataJSON: () => {
      if (options.throws === true) throw new SyntaxError("invalid JSON");
      return options.payload ?? hotExitPayload();
    },
    url: () => options.url ?? "http://127.0.0.1:1983/api/editor/hot-exit/write",
  } as unknown as Request;
}

describe("matchesExactHotExitSnapshot", () => {
  it("accepts the complete expected buffer and its production identity", () => {
    expect(matchesExactHotExitSnapshot(hotExitPayload(), EXACT_EXPECTATION)).toBe(true);
  });

  it("treats CRLF as the same Monaco model text while preserving all other whitespace", () => {
    const crlfContent = EXACT_EXPECTATION.content.replace(/\n/gu, "\r\n");
    expect(
      matchesExactHotExitSnapshot(hotExitPayload({ content: crlfContent }), EXACT_EXPECTATION),
    ).toBe(true);
    expect(
      matchesExactHotExitSnapshot(
        hotExitPayload({ content: EXACT_EXPECTATION.content.replace("  return", " return") }),
        EXACT_EXPECTATION,
      ),
    ).toBe(false);
  });

  it("accepts an exactly empty replacement and rejects stale non-empty content", () => {
    const expected = { ...EXACT_EXPECTATION, content: "" };
    expect(matchesExactHotExitSnapshot(hotExitPayload({ content: "" }), expected)).toBe(true);
    expect(matchesExactHotExitSnapshot(hotExitPayload({ content: "stale\n" }), expected)).toBe(
      false,
    );
  });

  it("preserves the exact cardinality of repeated lines", () => {
    const expected = { ...EXACT_EXPECTATION, content: "same\nsame\n" };
    expect(matchesExactHotExitSnapshot(hotExitPayload({ content: "same\nsame\n" }), expected)).toBe(
      true,
    );
    expect(matchesExactHotExitSnapshot(hotExitPayload({ content: "same\n" }), expected)).toBe(
      false,
    );
    expect(
      matchesExactHotExitSnapshot(hotExitPayload({ content: "same\nsame\nsame\n" }), expected),
    ).toBe(false);
  });

  it.each([
    ["stale off-screen suffix", `${EXACT_EXPECTATION.content}stale\n`],
    ["truncated buffer", EXACT_EXPECTATION.content.slice(0, -3)],
    ["appended duplicate", `${EXACT_EXPECTATION.content}${EXACT_EXPECTATION.content}`],
  ])("rejects a %s", (_label, content) => {
    expect(matchesExactHotExitSnapshot(hotExitPayload({ content }), EXACT_EXPECTATION)).toBe(false);
  });

  it.each([
    ["paneId", "pane-2"],
    ["relativePath", "src/other.ts"],
    ["windowId", "other-editor"],
    ["workspaceRoot", "/workspace/other"],
  ])("rejects the wrong %s", (field, value) => {
    expect(matchesExactHotExitSnapshot(hotExitPayload({ [field]: value }), EXACT_EXPECTATION)).toBe(
      false,
    );
  });

  it.each([undefined, null, {}, { snapshot: null }, { snapshot: { content: 1 } }])(
    "rejects an invalid payload (%j)",
    (payload) => {
      expect(matchesExactHotExitSnapshot(payload, EXACT_EXPECTATION)).toBe(false);
    },
  );
});

describe("isExactHotExitWrite", () => {
  it("delegates an exact hot-exit POST payload to the pure snapshot matcher", () => {
    expect(isExactHotExitWrite(fakeRequest(), EXACT_EXPECTATION)).toBe(true);
  });

  it.each([
    fakeRequest({ method: "GET" }),
    fakeRequest({ url: "http://127.0.0.1:1983/api/editor/hot-exit/read" }),
    fakeRequest({ payload: hotExitPayload({ paneId: "pane-2" }) }),
    fakeRequest({ throws: true }),
  ])("rejects a non-matching request", (request) => {
    expect(isExactHotExitWrite(request, EXACT_EXPECTATION)).toBe(false);
  });
});
