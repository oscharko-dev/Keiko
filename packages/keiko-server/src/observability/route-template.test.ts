// Tests for the route-template reducer. Three properties are load-bearing:
//
//   * a customer-chosen identifier in a route parameter position never survives;
//   * a route the server actually declares stays READABLE, because a request line whose route is
//     unreadable is the reason the field incident took four releases;
//   * the literal vocabulary this module carries is exactly the literal vocabulary of the declared
//     route table, so the copy cannot drift into digesting a route word or accepting a stray one.

import { describe, expect, it } from "vitest";

import { API_ROUTES } from "../routes.js";
import {
  API_ROUTE_LITERAL_SEGMENTS,
  UI_ASSET_ROOT_SEGMENTS,
  redactRoutePath,
} from "./route-template.js";

const CAP = 160;

// Derived from the production route table, never restated: a hard-coded list of expected literals
// would move together with the constant it is supposed to be checking and could never fail.
function declaredLiteralSegments(): ReadonlySet<string> {
  const literals = new Set<string>();
  for (const route of API_ROUTES) {
    for (const segment of route.pattern.split("/")) {
      if (segment !== "" && !segment.startsWith(":")) literals.add(segment);
    }
  }
  return literals;
}

function sorted(values: Iterable<string>): readonly string[] {
  return [...values].sort((left, right) => left.localeCompare(right, "en-US"));
}

describe("route literal vocabulary", () => {
  // `routes.ts` reaches every route handler and every route handler reaches the logger, so the
  // reducer cannot import the route table without closing a module cycle through the redaction
  // choke point. It carries the literals as data instead — and this test is what makes that copy
  // safe: adding a route without adding its literals turns this red instead of quietly reducing
  // the new route to a line of digests.
  it("matches the literals of the declared route table exactly", () => {
    const declared = declaredLiteralSegments();
    const carried = new Set(API_ROUTE_LITERAL_SEGMENTS);
    expect(sorted(carried)).toEqual(sorted(declared));
  });

  it("keeps the UI asset roots separate from the route literals", () => {
    const declared = declaredLiteralSegments();
    for (const root of UI_ASSET_ROOT_SEGMENTS) {
      expect(declared.has(root)).toBe(false);
    }
  });

  // A `:param` name is the one thing that must never become a literal: `capsuleId` as a literal
  // would mean a capsule literally named `capsuleId`… and every other capsule name reduced, which
  // is fine — but it would also mean the vocabulary was built by reading the pattern wrong.
  it("carries no route parameter name as a literal", () => {
    for (const route of API_ROUTES) {
      for (const segment of route.pattern.split("/")) {
        if (!segment.startsWith(":")) continue;
        expect(API_ROUTE_LITERAL_SEGMENTS.has(segment.slice(1))).toBe(false);
      }
    }
  });

  // The value of this reducer is that a declared route stays legible. If a pattern's literals do
  // not all survive, the request line degrades to digests and the operator is back to guessing.
  it("reduces every declared route pattern to itself once its parameters are filled", () => {
    for (const route of API_ROUTES) {
      const filled = route.pattern
        .split("/")
        .map((segment) => (segment.startsWith(":") ? "Acme-Q3-Financials" : segment))
        .join("/");
      const reduced = redactRoutePath(filled, CAP);
      expect(reduced, route.pattern).toBeDefined();
      expect(reduced, route.pattern).not.toContain("Acme");
      const template = route.pattern.replaceAll(/:[A-Za-z0-9_]+/g, "{id}");
      expect(reduced?.replaceAll(/\{[0-9a-f]{16}\}/g, "{id}"), route.pattern).toBe(template);
    }
  });
});

describe("redactRoutePath", () => {
  it("elides a parameter segment and keeps the literals around it", () => {
    // The customer-chosen id never appears; the route shape does.
    expect(redactRoutePath("/api/local-knowledge/capsules/Acme-Q3/index", CAP)).toBe(
      "/api/local-knowledge/capsules/{id}/index",
    );
  });

  it("treats a trailing slash as the same route", () => {
    expect(redactRoutePath("/api/health/", CAP)).toBe("/api/health");
    expect(redactRoutePath("/", CAP)).toBe("/");
  });

  it("declines anything that is not a route this server serves", () => {
    expect(redactRoutePath("/Users/someone/Documents/report.pdf", CAP)).toBeUndefined();
    expect(redactRoutePath("/Volumes/External/customer-alpha", CAP)).toBeUndefined();
    expect(redactRoutePath("/var/lib/keiko/state.db", CAP)).toBeUndefined();
    expect(redactRoutePath("packages/keiko-server/src/store.ts", CAP)).toBeUndefined();
    expect(redactRoutePath("", CAP)).toBeUndefined();
  });

  it("declines a traversal segment even under a route root", () => {
    expect(redactRoutePath("/api/../../etc/passwd", CAP)).toBeUndefined();
    expect(redactRoutePath("/api/./config", CAP)).toBeUndefined();
  });

  it("declines a route deeper than the bounded segment count", () => {
    expect(redactRoutePath(`/api${"/x".repeat(20)}`, CAP)).toBeUndefined();
  });

  // Eliding a short segment to a digest makes the template LONGER than the path it came from, so
  // the caller's own string cap has to be applied after the reduction, not before it.
  it("declines a template that would exceed the caller's string cap", () => {
    // The elision is much shorter than the digest it replaced, so the cap has to be
    // tightened to still exercise the refusal it pins.
    expect(redactRoutePath("/api/a/b/c/d/e/f/g", 20)).toBeUndefined();
  });
});
