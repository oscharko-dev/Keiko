// Issue #542 (Epic #532) — impacted-set derivation for a bounded dependency walk.
//
// `GET /api/relationships/:id/dependencies` returns the walk INCLUDING its origin: the origin
// relationship is always in `report.relationships`, and both of the origin's endpoints are always
// in `report.endpoints` (the store's `runWalkFromOrigin` appends whichever one the seed did not
// cover). The origin is the thing being inspected — it is never part of its own impact.
//
// Two consumers used to do that subtraction by eye and got different, wrong answers:
//   • the inspector's "Forward/Reverse dependencies" counted `report.relationships.length`, which
//     includes the origin — so both figures were inflated by exactly one and could never read 0;
//   • the impact card dropped `endpoints[0]` (the seed) and kept the origin's OTHER endpoint, which
//     the walk appends at the end — so an isolated relationship still claimed one impacted object.
//
// This module is the single derivation both of them call, so the two views cannot disagree and
// neither can drift from the wire contract again.

import type { ApiRelationship, DependencyNode, DependencyReport } from "./api";

/** The inspected relationship: its id and its two endpoints, none of which is "impact". */
export interface ImpactOrigin {
  readonly relationshipId: string;
  readonly source: DependencyNode;
  readonly target: DependencyNode;
}

export interface ImpactSets {
  /** Relationships on the walked path, excluding the origin relationship itself. */
  readonly relationships: readonly ApiRelationship[];
  /** Endpoints the walk reached, excluding the origin's own two endpoints. */
  readonly endpoints: readonly DependencyNode[];
}

function endpointKey(node: DependencyNode): string {
  return `${node.kind}/${node.id}`;
}

export function deriveImpact(report: DependencyReport, origin: ImpactOrigin): ImpactSets {
  const originEndpoints = new Set([endpointKey(origin.source), endpointKey(origin.target)]);
  return {
    relationships: report.relationships.filter((rel) => rel.id !== origin.relationshipId),
    endpoints: report.endpoints.filter((node) => !originEndpoints.has(endpointKey(node))),
  };
}
