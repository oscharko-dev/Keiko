// File-type filtering of the review diff package (Issue #4134).

import { describe, expect, it } from "vitest";
import { reviewDiffFilterReason } from "./filters.js";

describe("reviewDiffFilterReason", () => {
  it.each([
    ["package-lock.json", "lockfile"],
    ["apps/web/pnpm-lock.yaml", "lockfile"],
    ["go.sum", "lockfile"],
    ["dist/app.MIN.js", "minified"],
    ["static/site.min.css", "minified"],
    ["dist/app.js.map", "generated"],
    ["src/api.generated.ts", "generated"],
    ["proto/user_pb2.py", "generated"],
    ["vendor/github.com/x/y.go", "vendored"],
    ["web/node_modules/pkg/index.js", "vendored"],
  ])("filters %s as %s", (path, reason) => {
    expect(reviewDiffFilterReason(path, [])).toBe(reason);
  });

  it("reviews ordinary sources, including a file named like a vendored directory", () => {
    expect(reviewDiffFilterReason("src/vendor.ts", [])).toBeUndefined();
    expect(reviewDiffFilterReason("src/lockfile.ts", [])).toBeUndefined();
    expect(reviewDiffFilterReason("README.md", [])).toBeUndefined();
  });

  it("excludes configured exact paths and directory prefixes first", () => {
    const excluded = ["docs/", "tools/gen.ts"];
    expect(reviewDiffFilterReason("docs/a.md", excluded)).toBe("review-config-excluded");
    expect(reviewDiffFilterReason("tools/gen.ts", excluded)).toBe("review-config-excluded");
    expect(reviewDiffFilterReason("tools/gen.tsx", excluded)).toBeUndefined();
    expect(reviewDiffFilterReason("docsx/a.md", excluded)).toBeUndefined();
  });
});
