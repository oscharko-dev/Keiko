import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_EDITOR_SCHEMA_VERSION,
  GIT_EDITOR_DIFF_MAX_BYTES,
  GIT_EDITOR_DIFF_MAX_FILES,
  GIT_EDITOR_BLAME_MAX_BYTES,
  GIT_EDITOR_BLAME_MAX_LINES,
} from "@oscharko-dev/keiko-contracts/git-editor";
import { fetchGitBlame, fetchGitStructuredDiff } from "./api";
import { resetClientDiagnosticWriter, setClientDiagnosticWriter } from "./client-diagnostics";

function stubJsonResponse(payload: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status,
      headers: new Headers({ "X-Keiko-Correlation-Id": "git-parser-safety-response" }),
      json: (): Promise<unknown> => Promise.resolve(payload),
    }),
  );
}

// Only this explicitly in-memory json() fixture carries accessors; wire JSON cannot.
function privateThrownPayload(): unknown {
  const error = Object.defineProperty(new Error(), "name", { value: "fixture-private-error-name" });
  return Object.defineProperty({}, "schemaVersion", {
    get: (): never => {
      throw error;
    },
  });
}

async function expectClosedGitRefusal(read: () => Promise<unknown>): Promise<void> {
  const diagnostic = vi.fn();
  setClientDiagnosticWriter(diagnostic);
  await expect(read()).rejects.toMatchObject({
    code: "CONTRACT_VALIDATION_FAILED",
    status: 502,
    message: expect.not.stringContaining("fixture-private"),
    correlationId: "git-parser-safety-response",
  });
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledWith(
    "bff:contract-validation-failed",
    expect.objectContaining({
      kind: "other",
      errorKind: "validation-failed",
      correlationId: "git-parser-safety-response",
    }),
  );
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("fixture-private");
  expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("private-repository");
}

const endpoints: readonly { name: string; read: () => Promise<unknown>; healthy: unknown }[] = [
  {
    name: "structured diff",
    read: () => fetchGitStructuredDiff({ root: "/private-repository", scope: "staged" }),
    healthy: {
      schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
      scope: "staged",
      files: [],
      truncated: false,
      totalFiles: 0,
      totalBytes: 0,
      maxBytes: GIT_EDITOR_DIFF_MAX_BYTES,
      maxFiles: GIT_EDITOR_DIFF_MAX_FILES,
    },
  },
  {
    name: "blame",
    read: () =>
      fetchGitBlame({
        root: "/private-repository",
        path: "private-file",
        startLine: 1,
        maxLines: 1,
      }),
    healthy: {
      schemaVersion: GIT_EDITOR_SCHEMA_VERSION,
      path: "private-file",
      startLine: 1,
      lines: [],
      truncated: false,
      totalLines: 0,
      totalBytes: 0,
      maxBytes: GIT_EDITOR_BLAME_MAX_BYTES,
      maxLines: GIT_EDITOR_BLAME_MAX_LINES,
    },
  },
];

for (const endpoint of endpoints) {
  describe(`Git ${endpoint.name} parser failure evidence (#3918)`, () => {
    afterEach(() => {
      resetClientDiagnosticWriter();
      vi.unstubAllGlobals();
    });
    it.each(["fixture-private-primitive", null, 7])(
      "retains response correlation for malformed %j",
      async (payload) => {
        stubJsonResponse(payload);
        await expectClosedGitRefusal(endpoint.read);
      },
    );
    it("retains response correlation for an empty 204 response", async () => {
      const json = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 204,
          headers: new Headers({ "X-Keiko-Correlation-Id": "git-parser-safety-response" }),
          json,
        }),
      );
      await expectClosedGitRefusal(endpoint.read);
      expect(json).not.toHaveBeenCalled();
    });
    it("refuses an in-memory private named error through the existing diagnostic", async () => {
      stubJsonResponse(privateThrownPayload());
      await expectClosedGitRefusal(endpoint.read);
    });
    it("returns the original healthy response without a failure diagnostic", async () => {
      const diagnostic = vi.fn();
      setClientDiagnosticWriter(diagnostic);
      stubJsonResponse(endpoint.healthy);
      await expect(endpoint.read()).resolves.toBe(endpoint.healthy);
      expect(diagnostic).not.toHaveBeenCalled();
    });
  });
}
