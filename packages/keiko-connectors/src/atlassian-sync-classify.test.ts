// Direct unit tests for atlassian-sync-classify.ts's single-host URL builder (KEIKO-0606). The
// module is package-internal (deliberately not part of the public barrel surface per its header
// comment), so this file imports it directly by relative path, matching the sibling pattern in
// jira-write-actions.test.ts and confluence-sync-adapter.test.ts.
//
// atlassianApiUrl's host/scheme re-check is "defense in depth" (ADR-0128 D3): the base URL is
// already validated by atlassianApiEndpointsFor's isSafeAtlassianConnectorBaseUrl call before
// construction, so a crafted `issueId`-style relative segment alone cannot reach this guard in
// production — `new URL(base.origin + apiRootPath + relative)` has already committed to
// `base.origin`'s host by the time any character of `relative` is read, regardless of `../`, `@`,
// `//`, or an embedded `https://` inside it (confirmed interactively; no combination changes
// target.host when apiRootPath starts with "/", which it always does via
// atlassianApiEndpointsFor). The guard IS reachable, but only via a malformed `apiRootPath` — which
// itself is unreachable in production because `isSafeAtlassianConnectorBaseUrl`'s `!value.includes
// ("@")` check already rejects a base URL that could produce one. This test exercises
// atlassianApiUrl's own fail-closed behavior in isolation by constructing a synthetic
// AtlassianApiEndpoints object directly, bypassing the validated factory — true defense in depth,
// matching the function's own "the same check twice is intentional" framing.

import { describe, expect, it } from "vitest";
import { AtlassianCredentialCustodyError } from "./atlassian-credential-custody.js";
import { atlassianApiUrl, type AtlassianApiEndpoints } from "./atlassian-sync-classify.js";

describe("atlassianApiUrl", () => {
  it("throws invalid-input when a malformed apiRootPath moves the resolved URL off the configured host (userinfo-boundary confusion)", () => {
    // `new URL("https://good.example.com" + "@evil.example.com/rest/api/3/" + "issue/1")` parses
    // to host "evil.example.com" — the "@" turns the intended path prefix into URL userinfo,
    // handing the following segment the authority position. Verified interactively before writing
    // this test (see the module header above).
    const endpoints: AtlassianApiEndpoints = {
      base: new URL("https://good.example.com"),
      apiRootPath: "@evil.example.com/rest/api/3/",
    };
    let caught: unknown;
    try {
      atlassianApiUrl(endpoints, "issue/1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AtlassianCredentialCustodyError);
    expect((caught as AtlassianCredentialCustodyError).code).toBe("invalid-input");
  });

  it("throws invalid-input when the configured base itself resolves off https (protocol branch, independent of the host branch)", () => {
    // Isolates the guard's second condition (`target.protocol !== "https:"`): host matches exactly
    // (both resolve to "tenant.example.com"), so only the protocol check can be failing this case.
    // A synthetic http:// base cannot occur via the validated atlassianApiEndpointsFor factory
    // (isSafeAtlassianConnectorBaseUrl rejects non-https), which is exactly why this test builds
    // the endpoints object directly instead.
    const endpoints: AtlassianApiEndpoints = {
      base: new URL("http://tenant.example.com"),
      apiRootPath: "/rest/api/3/",
    };
    let caught: unknown;
    try {
      atlassianApiUrl(endpoints, "issue/1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AtlassianCredentialCustodyError);
    expect((caught as AtlassianCredentialCustodyError).code).toBe("invalid-input");
  });

  it("does not throw and returns the plain concatenated URL for an ordinary same-host request (no false positive)", () => {
    const endpoints: AtlassianApiEndpoints = {
      base: new URL("https://tenant.example.com"),
      apiRootPath: "/rest/api/3/",
    };
    expect(atlassianApiUrl(endpoints, "issue/PROJ-1")).toBe(
      "https://tenant.example.com/rest/api/3/issue/PROJ-1",
    );
  });
});
