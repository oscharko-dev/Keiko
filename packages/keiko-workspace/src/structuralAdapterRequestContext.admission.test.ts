import { describe, expect, it } from "vitest";
import { memFs } from "./_memfs.js";
import { DEFAULT_SEARCH_LIMITS, type SearchScope } from "./repoSearch.js";
import { createStructuralAdapterRequestContext } from "./structuralAdapterRequestContext.js";

const ROOT = "/workspace";
const BLOCKED = "src/blocked.ts";
const HEALTHY = "src/healthy.ts";
const SCOPE: SearchScope = {
  scopeId: "admission-binding",
  relativePaths: [],
  workspace: {
    root: ROOT,
    selectedRoot: ROOT,
    name: "fixture",
    version: undefined,
    testFramework: "unknown",
    sourceDirs: ["src"],
    testDirs: [],
    languages: ["typescript"],
    ignoreLines: [],
  },
};

describe("structural inventory preserves live request admission", () => {
  it.each([
    "codeIntelligenceIndex",
    "symbolGraph",
    "importGraph",
    "endpointContractGraph",
  ] as const)(
    "checks a previously memoized candidate inventory before %s reads content",
    async (graph) => {
      const base = memFs(ROOT, {
        [BLOCKED]: "export const blocked = 1;",
        [HEALTHY]: "export const healthy = 2;",
      });
      const reads: string[] = [];
      const read = base.readFileBytes;
      const containedRead = base.readFileUtf8WithinRootSameDescriptor;
      const descriptorRead = base.readFileUtf8SameDescriptor;
      if (read === undefined || containedRead === undefined || descriptorRead === undefined)
        throw new TypeError("Bounded content readers are required.");
      let allowed = true;
      const context = createStructuralAdapterRequestContext(
        SCOPE,
        DEFAULT_SEARCH_LIMITS,
        {
          ...base,
          readFileUtf8: (path) => {
            reads.push(path);
            return base.readFileUtf8(path);
          },
          readFileUtf8WithinRootSameDescriptor: (...args) => {
            reads.push(args[1]);
            return containedRead(...args);
          },
          readFileUtf8SameDescriptor: (...args) => {
            reads.push(args[0]);
            return descriptorRead(...args);
          },
          readFileBytes: (...args) => {
            reads.push(args[0]);
            return read(...args);
          },
        },
        {
          isCandidateAllowed: (path) => allowed || path !== BLOCKED,
        },
      );
      expect(context.candidatePaths()).toContain(BLOCKED);
      allowed = false;
      await context[graph]();
      expect(reads).not.toContain(`${ROOT}/${BLOCKED}`);
      expect(reads).toContain(`${ROOT}/${HEALTHY}`);
      expect(context.candidatePaths()).not.toContain(BLOCKED);
    },
  );
});
