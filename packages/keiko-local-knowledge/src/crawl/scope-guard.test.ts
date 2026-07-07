import type { HtmlManualCrawlScope } from "@oscharko-dev/keiko-contracts";
import { describe, expect, it } from "vitest";
import { evaluateManualCrawlLink, type CrawlLinkDecision } from "./scope-guard.js";

const HTTP_SCOPE: HtmlManualCrawlScope = {
  kind: "html-manual-http",
  origin: "https://docs.internal",
  pathPrefix: "/handbook",
};

const LOCAL_SCOPE: HtmlManualCrawlScope = {
  kind: "html-manual-local",
  rootPath: "manuals/x",
};

function httpLink(
  rawLink: string,
  base = "https://docs.internal/handbook/index.html",
): CrawlLinkDecision {
  return evaluateManualCrawlLink({ rawLink, baseKey: base, baseDepth: 0, scope: HTTP_SCOPE });
}

function localLink(rawLink: string, base = "index.html"): CrawlLinkDecision {
  return evaluateManualCrawlLink({ rawLink, baseKey: base, baseDepth: 0, scope: LOCAL_SCOPE });
}

describe("evaluateManualCrawlLink — http scope", () => {
  it("allows a same-origin link under the approved path prefix and canonicalises it", () => {
    const decision = httpLink("guide.html?theme=dark#section");
    expect(decision.allow).toBe(true);
    if (decision.allow) {
      expect(decision.canonicalKey).toBe("https://docs.internal/handbook/guide.html");
      expect(decision.relativePath).toBe("handbook/guide.html");
      expect(decision.depth).toBe(1);
      expect(decision.target).toEqual({
        kind: "http",
        url: "https://docs.internal/handbook/guide.html",
      });
    }
  });

  it("resolves a directory-style link to an index document", () => {
    const decision = httpLink("chapters/");
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.relativePath).toBe("handbook/chapters/index.html");
  });

  it("denies a cross-origin link", () => {
    expect(httpLink("https://evil.example/x.html")).toMatchObject({
      allow: false,
      reason: "cross-origin",
    });
  });

  it("denies a metadata address as cross-origin before any fetch", () => {
    expect(httpLink("http://169.254.169.254/latest/meta-data")).toMatchObject({
      allow: false,
      reason: "cross-origin",
    });
  });

  it("denies a credentialed url", () => {
    expect(httpLink("https://user:pass@docs.internal/handbook/x.html")).toMatchObject({
      allow: false,
      reason: "credentialed-url",
    });
  });

  it("denies a link outside the approved path prefix", () => {
    expect(httpLink("/other/secret.html")).toMatchObject({
      allow: false,
      reason: "outside-path-prefix",
    });
  });

  it("denies unsupported schemes and action links", () => {
    expect(httpLink("mailto:ops@docs.internal")).toMatchObject({
      allow: false,
      reason: "unsupported-scheme",
    });
    expect(httpLink("javascript:alert(1)")).toMatchObject({
      allow: false,
      reason: "unsupported-scheme",
    });
    expect(httpLink("logout.html")).toMatchObject({ allow: false, reason: "action-link" });
  });

  it("denies non-html assets", () => {
    expect(httpLink("styles/site.css")).toMatchObject({ allow: false, reason: "non-html" });
    expect(httpLink("img/diagram.png")).toMatchObject({ allow: false, reason: "non-html" });
  });

  it("allows any path when the prefix is the origin root", () => {
    const rootScope: HtmlManualCrawlScope = {
      kind: "html-manual-http",
      origin: "https://docs.internal",
      pathPrefix: null,
    };
    const decision = evaluateManualCrawlLink({
      rawLink: "/anywhere/page.html",
      baseKey: "https://docs.internal/",
      baseDepth: 0,
      scope: rootScope,
    });
    expect(decision.allow).toBe(true);
  });
});

describe("evaluateManualCrawlLink — local scope", () => {
  it("allows a relative sibling link", () => {
    const decision = localLink("chapters/intro.html");
    expect(decision.allow).toBe(true);
    if (decision.allow) {
      expect(decision.relativePath).toBe("chapters/intro.html");
      expect(decision.target).toEqual({
        kind: "local",
        rootPath: "manuals/x",
        relativePath: "chapters/intro.html",
      });
    }
  });

  it("resolves parent-directory links that stay within the root", () => {
    const decision = localLink("../shared/appendix.html", "chapters/intro.html");
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.relativePath).toBe("shared/appendix.html");
  });

  it("denies a traversal escape above the manual root", () => {
    expect(localLink("../../etc/passwd", "index.html")).toMatchObject({
      allow: false,
      reason: "path-traversal",
    });
  });

  it("denies a percent-encoded traversal escape above the manual root", () => {
    expect(localLink("%2e%2e/%2e%2e/etc/passwd", "index.html")).toMatchObject({
      allow: false,
      reason: "path-traversal",
    });
  });

  it("denies a mixed percent-encoded traversal escape above the manual root", () => {
    expect(localLink("..%2f..%2fetc%2fpasswd", "index.html")).toMatchObject({
      allow: false,
      reason: "path-traversal",
    });
  });

  it("denies a doubly percent-encoded traversal escape above the manual root", () => {
    expect(localLink("%252e%252e/%252e%252e/etc/passwd", "index.html")).toMatchObject({
      allow: false,
      reason: "path-traversal",
    });
  });

  it("denies hidden and credential files", () => {
    expect(localLink(".env")).toMatchObject({ allow: false, reason: "path-traversal" });
    expect(localLink(".git/config")).toMatchObject({ allow: false, reason: "path-traversal" });
    expect(localLink("id_rsa")).toMatchObject({ allow: false, reason: "path-traversal" });
  });

  it("denies external http links and unsupported schemes from a local page", () => {
    expect(localLink("https://docs.internal/x.html")).toMatchObject({
      allow: false,
      reason: "cross-origin",
    });
    expect(localLink("mailto:x@y.z")).toMatchObject({
      allow: false,
      reason: "unsupported-scheme",
    });
  });

  it("denies action links and non-html assets locally", () => {
    expect(localLink("login.html")).toMatchObject({ allow: false, reason: "action-link" });
    expect(localLink("assets/app.js")).toMatchObject({ allow: false, reason: "non-html" });
  });

  it("strips fragments and queries when canonicalising a local link", () => {
    const decision = localLink("page.html?x=1#top");
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.relativePath).toBe("page.html");
  });
});
