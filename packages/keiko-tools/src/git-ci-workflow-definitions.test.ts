import { describe, expect, it, vi } from "vitest";
import { collectGitCiRequirements } from "./git-ci-requirements.js";
import { readGitCiWorkflowDefinitions } from "./git-ci-workflow-definitions.js";
import { buildGitHubApiGetArgv } from "./git-provider-value.js";
import type { CommandResult } from "./types.js";

const SHA = "a".repeat(40);
const WORKFLOW = { repository_id: 2, path: ".github/workflows/quality.yml", ref: "refs/heads/dev" };
function requirements(
  workflows: readonly unknown[] = [WORKFLOW],
): ReturnType<typeof collectGitCiRequirements> {
  const values = [
    {
      type: "workflows",
      ruleset_id: 7,
      ruleset_source_type: "Organization",
      parameters: { workflows },
    },
  ];
  return collectGitCiRequirements({
    protection: { outcome: "unprotected" },
    rules: {
      values,
      completeness: { complete: true, pages: 1, bytes: 100, entries: values.length },
    },
  });
}
function response(value: unknown, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "gh",
    args: [],
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify(value),
    stderr: "",
    durationMs: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}
function fixture(): {
  readonly run: ReturnType<typeof vi.fn<(args: readonly string[]) => Promise<CommandResult>>>;
  readonly input: {
    readonly repositoryId: number;
    readonly repository: string;
    readonly requirements: ReturnType<typeof requirements>;
  };
} {
  const run = vi.fn((args: readonly string[]): Promise<CommandResult> =>
    Promise.resolve(
      response(
        args[5] === "/repositories/2" ? { id: 2, repository: "governance/policy" } : { sha: SHA },
      ),
    ),
  );
  return {
    run,
    input: { repositoryId: 1, repository: "owner/repo", requirements: requirements() },
  };
}
describe("required workflow metadata through the bounded provider owner", () => {
  it("resolves only the rule-selected repository ID and ref, without source content", async () => {
    const test = fixture();
    expect(await readGitCiWorkflowDefinitions({ ...test.input, run: test.run })).toEqual({
      status: "observed",
      definitions: [
        {
          repositoryId: 2,
          repository: "governance/policy",
          path: WORKFLOW.path,
          ref: WORKFLOW.ref,
          sha: SHA,
        },
      ],
    });
    expect(test.run.mock.calls.map(([args]) => args[5])).toEqual([
      "/repositories/2",
      "/repos/governance/policy/commits/refs%2Fheads%2Fdev",
    ]);
    expect(
      test.run.mock.calls.every(
        ([args]) => args.slice(0, 5).join(" ") === "api --hostname github.com --method GET",
      ),
    ).toBe(true);
    expect(test.run.mock.calls.map(([args]) => args.at(-1))).toEqual([
      "{id,repository:.full_name}",
      "{sha}",
    ]);
  });
  // #3390 wave8b residual: this module used to carry a local copy of the GitHub REST GET argv
  // envelope instead of importing the shared `buildGitHubApiGetArgv` producer. Deriving the
  // expectation from that SAME producer (never restating the literal array) proves the two never
  // drift apart again — a diverging local copy would fail this assertion the moment either side
  // changed (AGENTS.md §7: a fixture must derive from the production entry point).
  it("issues the byte-identical GitHub REST GET envelope the shared provider-value producer builds", async () => {
    const test = fixture();
    await readGitCiWorkflowDefinitions({ ...test.input, run: test.run });
    expect(test.run.mock.calls.map(([args]) => args)).toEqual([
      buildGitHubApiGetArgv("/repositories/2", "{id,repository:.full_name}"),
      buildGitHubApiGetArgv("/repos/governance/policy/commits/refs%2Fheads%2Fdev", "{sha}"),
    ]);
  });
  it("reuses identity and ref lookups only within one observation", async () => {
    const test = fixture();
    const input = {
      ...test.input,
      run: test.run,
      requirements: requirements([
        WORKFLOW,
        { ...WORKFLOW, path: ".github/workflows/security.yml" },
      ]),
    };
    await readGitCiWorkflowDefinitions(input);
    expect(test.run).toHaveBeenCalledTimes(2);
    await readGitCiWorkflowDefinitions(input);
    expect(test.run).toHaveBeenCalledTimes(4);
  });
  it("needs no provider lookup for a SHA-pinned definition in the known target repository", async () => {
    const test = fixture();
    const result = await readGitCiWorkflowDefinitions({
      ...test.input,
      run: test.run,
      requirements: requirements([{ ...WORKFLOW, repository_id: 1, sha: SHA }]),
    });
    expect(result).toMatchObject({
      status: "observed",
      definitions: [{ repository: "owner/repo", sha: SHA }],
    });
    expect(test.run).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { id: 3, repository: "governance/policy" },
    { id: 2, repository: "host.example/repo/extra" },
    { id: 2, repository: "governance/policy", body: "untrusted" },
  ])("rejects identity gaps instead of following a supplied endpoint: %j", async (value) => {
    const test = fixture();
    test.run.mockResolvedValue(response(value));
    expect(await readGitCiWorkflowDefinitions({ ...test.input, run: test.run })).toMatchObject({
      status: "unknown",
    });
    expect(test.run).toHaveBeenCalledOnce();
  });
  it.each([null, { sha: "HEAD" }, { sha: SHA, body: "untrusted" }])(
    "rejects malformed effective revisions: %j",
    async (value) => {
      const test = fixture();
      test.run
        .mockResolvedValueOnce(response({ id: 2, repository: "governance/policy" }))
        .mockResolvedValue(response(value));
      expect(await readGitCiWorkflowDefinitions({ ...test.input, run: test.run })).toMatchObject({
        status: "unknown",
      });
    },
  );
  it("preserves visibility failure and truncation without treating a ref as a SHA", async () => {
    for (const overrides of [{ exitCode: 1, stderr: "HTTP 403" }, { truncated: true }]) {
      const test = fixture();
      test.run.mockResolvedValue(response(null, overrides));
      expect(await readGitCiWorkflowDefinitions({ ...test.input, run: test.run })).toMatchObject({
        status: "unknown",
      });
    }
  });
  it("enforces both repository and definition bounds before IO", async () => {
    for (const workflows of [
      Array.from({ length: 5 }, (_, id) => ({ ...WORKFLOW, repository_id: id + 1 })),
      Array.from({ length: 9 }, (_, id) => ({
        ...WORKFLOW,
        path: `.github/workflows/check-${String(id)}.yml`,
      })),
    ]) {
      const test = fixture();
      expect(
        await readGitCiWorkflowDefinitions({
          ...test.input,
          run: test.run,
          requirements: requirements(workflows),
        }),
      ).toMatchObject({ status: "unknown" });
      expect(test.run).not.toHaveBeenCalled();
    }
  });
  it("stops cancelled metadata reads before spawning a command", async () => {
    const test = fixture();
    expect(
      await readGitCiWorkflowDefinitions({
        ...test.input,
        run: test.run,
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({
      status: "unknown",
      failure: { reason: "cancelled" },
    });
    expect(test.run).not.toHaveBeenCalled();
  });
});
