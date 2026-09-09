import { describe, expect, it } from "vitest";

import { createGitHubCodeContextConnector } from "./githubCodeContextConnector.js";

// KEIKO-#3384 B5-11 / B5-15 / reuse-duplication-1: this connector used to carry a private
// GitHub-object mapper that silently dropped the identity fields
// (providerId/providerNodeId/state/isPullRequest/commentCount) the shared `gh api` jq projection
// already fetches, instead of calling the canonical `gitHubCodeContextRawObjectFrom` that
// `codeContextConnector.ts` owns. That gap left every consumer reached through
// `createGitHubCodeContextConnector` (the chat/@mention coding-context pack route and the
// editor's connected-context provider) with those fields always undefined, even though the
// security path (`githubIssueResolution.ts`) already saw them via the canonical mapper. This test
// pins the identity fields flowing through the connector so a future edit cannot silently
// reintroduce a second, incomplete GitHub-object parser.
describe("createGitHubCodeContextConnector", () => {
  it("surfaces provider identity fields from the shared gh api jq projection", async () => {
    const api = {
      readJson: (argv: readonly string[]): Promise<unknown> => {
        if (argv[1]?.includes("/comments")) {
          return Promise.resolve([{ id: "1001", body: "review context comment" }]);
        }
        return Promise.resolve({
          id: "1989",
          nodeId: "I_kwDOExampleNodeId",
          state: "open",
          isPullRequest: false,
          title: "GitHub context",
          body: "issue body",
          comments: 1,
          url: "https://github.com/oscharko-dev/Keiko/issues/1989",
        });
      },
    };

    const raw = await createGitHubCodeContextConnector(api).read({
      source: "github",
      objectKind: "issue",
      ownerAndRepo: "oscharko-dev/Keiko",
      objectId: "1989",
    });

    expect(raw).toMatchObject({
      source: "github",
      objectKind: "issue",
      objectId: "1989",
      title: "GitHub context",
      body: "issue body",
      comments: [{ id: "1001", body: "review context comment" }],
      providerId: "1989",
      providerNodeId: "I_kwDOExampleNodeId",
      state: "open",
      isPullRequest: false,
      commentCount: 1,
    });
  });
});
