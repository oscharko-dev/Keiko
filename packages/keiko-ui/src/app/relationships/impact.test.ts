// Issue #542 (Epic #532) — impacted-set arithmetic on a hand-derivable graph.
//
// The graph under test (all endpoints are capsules, all edges `depends-on`):
//
//     cap-a --rel-origin--> cap-b --rel-b--> cap-c
//     cap-z --rel-z-------> cap-a
//
// Inspecting `rel-origin` (source cap-a, target cap-b):
//   • outgoing walk from cap-b reaches rel-b and cap-c → 1 impacted relationship, 1 endpoint.
//     The wire report additionally carries rel-origin and BOTH cap-a and cap-b, none of which is
//     impact.
//   • incoming walk from cap-a reaches rel-z and cap-z → 1 impacted relationship, 1 endpoint.
//   • an isolated relationship must produce a genuine zero in both directions — the wire report
//     still carries the origin relationship and its two endpoints.

import { describe, expect, it } from "vitest";
import { deriveImpact, type ImpactOrigin } from "./impact";
import type { ApiRelationship, DependencyReport } from "./api";

function capsule(id: string): { readonly kind: "capsule"; readonly id: string } {
  return { kind: "capsule", id };
}

function edge(id: string, sourceId: string, targetId: string): ApiRelationship {
  return {
    id,
    schemaVersion: "1",
    workspaceId: "local",
    type: "depends-on",
    source: capsule(sourceId),
    target: capsule(targetId),
    lifecycle: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    etag: 1,
  };
}

const ORIGIN: ImpactOrigin = {
  relationshipId: "rel-origin",
  source: capsule("cap-a"),
  target: capsule("cap-b"),
};

const REL_ORIGIN = edge("rel-origin", "cap-a", "cap-b");

function report(
  relationships: readonly ApiRelationship[],
  endpointIds: readonly string[],
): DependencyReport {
  return {
    rootRelationshipId: "rel-origin",
    depthReached: 1,
    truncated: false,
    relationships,
    endpoints: endpointIds.map(capsule),
  };
}

describe("deriveImpact", () => {
  it("counts the downstream set without the origin relationship or its endpoints", () => {
    // Outgoing walk: seeded from cap-b, appends cap-a last (runWalkFromOrigin).
    const outgoing = report(
      [REL_ORIGIN, edge("rel-b", "cap-b", "cap-c")],
      ["cap-b", "cap-c", "cap-a"],
    );
    const impact = deriveImpact(outgoing, ORIGIN);
    expect(impact.relationships.map((rel) => rel.id)).toEqual(["rel-b"]);
    expect(impact.endpoints.map((node) => node.id)).toEqual(["cap-c"]);
  });

  it("counts the upstream set without the origin relationship or its endpoints", () => {
    // Incoming walk: seeded from cap-a, appends cap-b last.
    const incoming = report(
      [REL_ORIGIN, edge("rel-z", "cap-z", "cap-a")],
      ["cap-a", "cap-z", "cap-b"],
    );
    const impact = deriveImpact(incoming, ORIGIN);
    expect(impact.relationships.map((rel) => rel.id)).toEqual(["rel-z"]);
    expect(impact.endpoints.map((node) => node.id)).toEqual(["cap-z"]);
  });

  it("yields a genuine zero for an isolated relationship in both directions", () => {
    for (const endpointIds of [
      ["cap-b", "cap-a"],
      ["cap-a", "cap-b"],
    ]) {
      const impact = deriveImpact(report([REL_ORIGIN], endpointIds), ORIGIN);
      expect(impact.relationships).toHaveLength(0);
      expect(impact.endpoints).toHaveLength(0);
    }
  });

  it("keeps a self-referential edge's endpoints out of the impacted set", () => {
    // cap-a --rel-origin--> cap-b and cap-b --rel-loop--> cap-a: the cycle walks back to the
    // origin's own endpoints, which are still the origin, not its impact.
    const outgoing = report([REL_ORIGIN, edge("rel-loop", "cap-b", "cap-a")], ["cap-b", "cap-a"]);
    const impact = deriveImpact(outgoing, ORIGIN);
    expect(impact.relationships.map((rel) => rel.id)).toEqual(["rel-loop"]);
    expect(impact.endpoints).toHaveLength(0);
  });
});
