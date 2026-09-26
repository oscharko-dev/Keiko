import { describe, expect, it } from "vitest";
import { isGitCiFailureContextResult } from "@oscharko-dev/keiko-contracts/runtime/git-delivery-provider";
import { readGitCiFailureContext } from "./git-ci-failure-context.js";
import { failureFacts, failureRunner } from "./git-ci-failure-context-test-support.js";

async function produced(): Promise<
  Extract<Awaited<ReturnType<typeof readGitCiFailureContext>>, { status: "observed" }>
> {
  const facts = failureFacts();
  const result = await readGitCiFailureContext({
    facts,
    run: failureRunner(facts),
    stillAuthorized: (): boolean => true,
  });
  if (result.status !== "observed") throw new Error("Missing production failure context");
  return result;
}
describe("transient CI diagnostics at the shared wire boundary", () => {
  it("accepts the actual bounded redacted producer output", async () => {
    expect(isGitCiFailureContextResult(await produced())).toBe(true);
  });
  it.each([
    { trust: "trusted" },
    { usage: "execute" },
    { sourceCount: 0 },
    { sourceCount: 5 },
    { repository: "https://github.com/owner/repo" },
    { headSha: "main" },
    { body: "extra" },
    { completeness: { complete: true, entries: 0, pages: 0, bytes: 0 } },
  ])("rejects changed trust, identity, completeness or closed shape %#", async (change) => {
    const result = await produced();
    expect(
      isGitCiFailureContextResult({ ...result, context: { ...result.context, ...change } }),
    ).toBe(false);
  });
  it.each([
    { text: "a".repeat(2049) },
    { text: "\u001b[31m" },
    { title: "ü".repeat(129) },
    { command: "run" },
    { sourceId: -1 },
    { jobId: 1 },
  ])("rejects excessive or executable entry fields %#", async (change) => {
    const result = await produced();
    expect(
      isGitCiFailureContextResult({
        ...result,
        context: {
          ...result.context,
          entries: [
            { ...result.context.entries[0], ...change },
            ...result.context.entries.slice(1),
          ],
        },
      }),
    ).toBe(false);
  });
  it("bounds the whole serialized result independently of each entry", async () => {
    const result = await produced();
    const entries = Array.from({ length: 32 }, () => ({
      ...result.context.entries[0],
      text: "x".repeat(2048),
    }));
    expect(
      isGitCiFailureContextResult({
        ...result,
        context: {
          ...result.context,
          entries,
          completeness: { ...result.context.completeness, entries: 32 },
        },
      }),
    ).toBe(false);
  });
});
