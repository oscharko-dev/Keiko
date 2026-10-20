import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXPLORATION_BUDGET,
  validateConnectedContextPack,
} from "@oscharko-dev/keiko-contracts/connected-context";
import { memFs } from "@oscharko-dev/keiko-workspace/testing";
import { testSourcePairingAdapter } from "@oscharko-dev/keiko-workspace/code-intelligence";
import { createBufferedServerLogSink } from "../../../tests/support/buffered-server-log.js";
import { retrieveConnectedContextPack, type RetrievalOnlyOutput } from "./grounded-orchestrator.js";

const ROOT = "/structural-reservation-fixture";
const NOW = 1_700_000_000_000;

function implementation(name: string): string {
  return `import { useState } from "react";
import { Alert, Button } from "@mui/material";
export interface ${name}Props {
  reserve: () => Promise<string>;
  disabled?: boolean;
}
export function ${name}({ reserve, disabled = false }: ${name}Props) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(): Promise<void> {
    setPending(true);
    setMessage("");
    try { setMessage(await reserve()); }
    catch { setMessage("Reservation failed"); }
    finally { setPending(false); }
  }
  return <>
    <Button disabled={disabled || pending} onClick={() => { void submit(); }}>
      {pending ? "Reserving…" : "Reserve"}
    </Button>
    {message && <Alert>{message}</Alert>}
  </>;
}
`;
}

function fixture(name: string): Readonly<Record<string, string>> {
  return {
    "README.md": `# Reservation button unit test contract
Use installed Vitest, React Testing Library and user-event with real React and MUI components.
Mock only the reserve callback. Place the complete file at src/${name}.test.tsx.
Use English descriptions beginning with should and Arrange/Act/Assert sections.
R2: While pending, Reserving… is disabled and extra clicks cannot call reserve.
R5: A disabled button never calls reserve.
`,
    "package.json": '{"name":"reservation-fixture","type":"module","private":true}\n',
    "tsconfig.json": '{"compilerOptions":{"jsx":"react-jsx","strict":true}}\n',
    [`src/${name}.tsx`]: implementation(name),
    "src/Neighbor.test.ts":
      'import { expect, it } from "vitest"; it("should retain its neighbor", () => expect(2).toBe(2));\n',
    "test/setup.ts": 'import "@testing-library/jest-dom/vitest";\n',
    "vitest.config.mjs": 'export default { test: { environment: "jsdom" } };\n',
  };
}

function feedback(name: string): string {
  return `The generated frontend/src/${name}.test.tsx has the following observed verification failures against the unchanged correct application:
Actual correct-application test failure: {"test": "${name} should not call reserve more than once while pending (R2)", "messages": ["Error: Unable to perform pointer interaction as the element has pointer-events: none: BUTTON(label=Reserving…)"]}
Actual correct-application test failure: {"test": "${name} should never call reserve when the button is disabled (R5)", "messages": ["Error: Unable to perform pointer interaction as the element has pointer-events: none: BUTTON(label=Reserve)"]}
Read the connected frontend README, implementation, configuration and neighboring test as needed. Correct the complete test file while preserving the original accepted requirements, naming, mock policy and requested section pattern. Keep the application unchanged. Return one complete TypeScript React code block. Claim verification only after observed execution.`;
}

async function retrieve(
  name: string,
  searchCallsMax = 16,
): Promise<
  RetrievalOnlyOutput & { events: ReturnType<typeof createBufferedServerLogSink>["events"] }
> {
  const activityLog = createBufferedServerLogSink();
  const result = await retrieveConnectedContextPack(
    {
      workspaceRoot: ROOT,
      scope: {
        schemaVersion: "1",
        scopeId: "reservation",
        workspaceRoot: ROOT,
        kind: "workspace-root",
        relativePaths: [],
        conversationId: undefined,
        connectedAtMs: NOW,
        explicitConnection: true,
      },
      query: {
        kind: "natural-language",
        text: feedback(name),
        caseSensitive: false,
        maxResults: 116_000,
        emittedAtMs: NOW,
      },
      budget: { ...DEFAULT_EXPLORATION_BUDGET, searchCallsMax },
    },
    {
      correlationId: "structural-reservation",
      activityLog,
      fs: memFs(ROOT, fixture(name)),
      nowMs: () => NOW,
      detectWorkspace: () => ({
        root: ROOT,
        selectedRoot: ROOT,
        name: "reservation-fixture",
        version: undefined,
        testFramework: "vitest",
        sourceDirs: ["src"],
        testDirs: ["src"],
        languages: ["typescript"],
        ignoreLines: [],
      }),
      answerer: {
        answer: (): Promise<string> => Promise.reject(new Error("No model in retrieval proof")),
      },
    },
  );
  return { ...result, events: activityLog.events };
}

describe("admitted structural search reservations", () => {
  it.each(["ActionButton", "CheckoutPanel"])(
    "retains the current implementation for diagnostic feedback about an absent %s test",
    async (name) => {
      const { pack, events } = await retrieve(name);
      expect(
        pack.files
          .find((file) => file.scopePath === `src/${name}.tsx`)
          ?.excerpts.some((excerpt) => excerpt.content.includes(implementation(name).trimEnd())),
      ).toBe(true);
      expect(pack.usage.searchCalls).toBeLessThanOrEqual(pack.budget.searchCallsMax);
      expect(validateConnectedContextPack(pack).ok).toBe(true);
      expect(
        events.find((event) => event.op === "search.connected-context.completed")?.extra,
      ).toMatchObject({ usageSearchCalls: pack.usage.searchCalls });
      expect(
        events.find((event) => event.op === "search.connected-context.completed")?.extra
          ?.executedRingKinds,
      ).toContain("structural");
      expect(
        events.find((event) => event.op === "search.connected-context.completion-details")?.extra
          ?.structuralContextCount,
      ).toBeGreaterThan(0);
      expect(pack.uncertainty.some((entry) => entry.claim.includes("searchCalls"))).toBe(true);
    },
  );

  it("does not admit searches or source reads under a zero search grant", async () => {
    const { pack } = await retrieve("ActionButton", 0);
    expect(pack.usage.searchCalls).toBe(0);
    expect(pack.files).toHaveLength(0);
    expect(validateConnectedContextPack(pack).ok).toBe(true);
  });

  it.each([1, 2, 3, 8, 16])("bounds adapter admission by a %i-call grant", async (grant) => {
    const lookup = vi.spyOn(testSourcePairingAdapter, "lookup");
    try {
      const { pack } = await retrieve("ActionButton", grant);
      expect(lookup.mock.calls.length).toBeLessThanOrEqual(grant);
      expect(pack.usage.searchCalls).toBeLessThanOrEqual(grant);
      expect(pack.budget.searchCallsMax).toBe(grant);
      expect(validateConnectedContextPack(pack).ok).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  });
});
