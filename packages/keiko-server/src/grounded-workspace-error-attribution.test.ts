import { describe, expect, it } from "vitest";
import { PathDeniedError, RepoSearchInvalidQueryError } from "@oscharko-dev/keiko-workspace";
import { mappedWorkspaceError } from "./grounded-qa.js";

function collected(primary: Error): AggregateError {
  const attributed = Object.assign(
    new Error("Repository search file processing failed.", { cause: primary }),
    { requestedPath: "private/customer/a.ts" },
  );
  return new AggregateError(
    [attributed, new RangeError("secondary")],
    "Search processing failed.",
    { cause: attributed },
  );
}

describe("collected workspace error mapping", () => {
  it("preserves a primary file policy denial instead of changing it into INTERNAL_ERROR", () => {
    const failure = new PathDeniedError("private policy detail", "private/customer/a.ts");
    const mapped = mappedWorkspaceError(collected(failure));
    expect(mapped).toEqual(mappedWorkspaceError(failure));
    expect(mapped).toMatchObject({
      status: 400,
      body: { error: { code: "WORKSPACE_PATH_DENIED" } },
    });
    expect(JSON.stringify(mapped)).not.toContain("private");
  });

  it("preserves typed request validation from an attributed primary failure", () => {
    const failure = new RepoSearchInvalidQueryError("Invalid query.");
    expect(mappedWorkspaceError(collected(failure))).toEqual(mappedWorkspaceError(failure));
  });

  it("does not hide a programmer failure behind a secondary policy error or arbitrary cause", () => {
    const denied = new PathDeniedError("private policy detail", "private/customer/a.ts");
    const primary = new TypeError("private programmer detail");
    expect(
      mappedWorkspaceError(
        new AggregateError([primary, denied], "Search failed.", { cause: primary }),
      ),
    ).toBeUndefined();
    expect(mappedWorkspaceError(new Error("Other failure.", { cause: denied }))).toBeUndefined();
  });
});
