import { expect } from "vitest";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  SPRINT_LIFECYCLE_FIXTURE_CASES,
  sprintLifecycleFixture,
} from "./jira-sprint-lifecycle-fixture.js";
import { nativeOutcomeResponse, reviewedAgileTransport } from "./jira-managed-remote.js";

type SprintCase = (typeof SPRINT_LIFECYCLE_FIXTURE_CASES)[number];
const NATIVE_BODIES: Readonly<Record<SprintCase["name"], CatalogJsonObject | undefined>> = {
  "jira.replace-sprint": {
    name: "Synthetic renamed",
    state: "future",
    startDate: null,
    endDate: null,
    goal: null,
    autoStartStop: false,
    incompleteIssuesDestinationId: null,
    id: 11,
    originBoardId: 7,
    synced: false,
  },
  "jira.delete-sprint": undefined,
  "jira.swap-sprints": { sprintToSwapWith: 12 },
  "jira.unmap-sprints": { sprintIds: [12] },
  "jira.unmap-all-sprints": undefined,
};
function selectedReadPath(url: URL, platformRoot: string, agileRoot: string): string | undefined {
  if (url.pathname.startsWith(`${platformRoot}/`)) {
    const path = url.pathname.slice(platformRoot.length + 1);
    return path === "myself" || path === "field" ? path : undefined;
  }
  if (!url.pathname.startsWith(`${agileRoot}/`)) return undefined;
  const path = url.pathname.slice(agileRoot.length + 1);
  return /^sprint\/(?:11|12)$/u.test(path) || path === "board/7" || path === "board/7/sprint"
    ? path
    : undefined;
}
interface SprintTransportFixture {
  readonly read: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => CatalogJsonObject;
}
type SprintFixture = ReturnType<typeof sprintLifecycleFixture>;

async function sprintRead(
  fixture: SprintFixture,
  request: AtlassianHttpBodyRequest,
  roots: readonly [string, string],
): Promise<AtlassianHttpBodyResult | undefined> {
  expect(request.jiraExperimental).toBeUndefined();
  const url = new URL(request.url);
  const path = selectedReadPath(url, roots[0], roots[1]);
  if (path === undefined) return undefined;
  expect(url.search).toBe(path === "board/7/sprint" ? "?startAt=0&maxResults=100" : "");
  return nativeOutcomeResponse(
    await fixture.ports.requests.agile(`${path}${url.search}`, "GET", undefined, "json"),
  );
}

/** Reuses the independent synthetic sprint state. This adapter asserts the actual serialized
 * native wire before handing that known literal body to the existing fixture; no JSON recast. */
export function sprintLifecycleTransportFixture(
  platformRoot: string,
  agileRoot: string,
  selected: SprintCase,
  actorKey = "synthetic-actor",
): SprintTransportFixture {
  const fixture = sprintLifecycleFixture();
  fixture.actor.key = actorKey;
  return reviewedAgileTransport({
    snapshot: fixture.snapshot,
    read: (request) => sprintRead(fixture, request, [platformRoot, agileRoot]),
    root: agileRoot,
    selected,
    body: NATIVE_BODIES[selected.name],
    experimental:
      selected.name === "jira.unmap-sprints" || selected.name === "jira.unmap-all-sprints"
        ? true
        : undefined,
    port: fixture.ports.requests.agile,
  });
}
