import { describe, expect, it } from "vitest";
import { buildPrBodyReadArgv, buildPrBodyUpdateArgv, parseGitPrBody } from "./git-pr-body.js";

const identity = {
  number: 123,
  externalId: "PR_Test",
  url: "https://github.com/owner/repo/pull/123",
  repository: "owner/repo",
  headRepository: "fork/repo",
  headRef: "feature",
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  state: "open",
  isDraft: true,
};
const request = { ownerAndRepo: "owner/repo", prExternalId: "123" };
describe("body-only PR command boundary", () => {
  it("builds a single canonical PATCH containing only the literal body field", () => {
    expect(buildPrBodyUpdateArgv({ ...request, body: "@file\nbody=x" })).toEqual([
      "api",
      "--hostname",
      "github.com",
      "--method",
      "PATCH",
      "/repos/owner/repo/pulls/123",
      "-f",
      "body=@file\nbody=x",
      "--jq",
      ".number",
    ]);
    expect(buildPrBodyReadArgv(request)).toContain("GET");
  });
  it.each(["title", "base", "draft", "merge", "command", "args", "endpoint", "headers"])(
    "refuses an extra %s field before argv exists",
    (field) => {
      expect(() => buildPrBodyUpdateArgv({ ...request, body: "body", [field]: "bad" })).toThrow();
    },
  );
  it("parses exact raw markdown, including empty and CRLF bodies, with real provider timestamp", () => {
    for (const body of [null, "A\r\n\r\nCloses #42\r\n"]) {
      expect(
        parseGitPrBody({ identity, body, updatedAt: "2026-09-05T00:00:00Z" }, request),
      ).toEqual({ identity, body: body ?? "", updatedAt: "2026-09-05T00:00:00.000Z" });
    }
  });
  it.each([
    { identity: { ...identity, number: 124 } },
    { identity: { ...identity, repository: "other/repo" } },
    { updatedAt: "invalid" },
    { body: 42 },
    { body: "x".repeat(65_537) },
    { secret: "bad" },
  ])("refuses incomplete, foreign or oversized provider facts %j", (patch) => {
    expect(
      parseGitPrBody({ identity, body: "", updatedAt: "2026-09-05T00:00:00Z", ...patch }, request),
    ).toBeUndefined();
  });
});

it("rejects ill-formed Unicode that would change on the process UTF-8 boundary", () => {
  expect(() => buildPrBodyUpdateArgv({ ...request, body: "human\ud800text" })).toThrow();
  expect(parseGitPrBody({ identity, body: "", updatedAt: "1" }, request)).toBeUndefined();
});
