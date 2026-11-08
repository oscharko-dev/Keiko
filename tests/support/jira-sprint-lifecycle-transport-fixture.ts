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
import { response } from "./jira-managed-remote.js";

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
/** Reuses the independent synthetic sprint state. This adapter asserts the actual serialized
 * native wire before handing that known literal body to the existing fixture; no JSON recast. */
export function sprintLifecycleTransportFixture(
  platformRoot: string,
  agileRoot: string,
  selected: SprintCase,
  actorKey = "synthetic-actor",
): {
  readonly read: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => CatalogJsonObject;
} {
  const fixture = sprintLifecycleFixture();
  fixture.actor.key = actorKey;
  let writes = 0;
  return {
    snapshot: fixture.snapshot,
    async read(request) {
      expect(request.jiraExperimental).toBeUndefined();
      const url = new URL(request.url);
      const path = selectedReadPath(url, platformRoot, agileRoot);
      if (path === undefined) return undefined;
      expect(url.search).toBe(path === "board/7/sprint" ? "?startAt=0&maxResults=100" : "");
      const result = await fixture.ports.requests.agile(
        `${path}${url.search}`,
        "GET",
        undefined,
        "json",
      );
      return result.ok
        ? response(result.items ?? result.body, result.status)
        : response({}, result.httpStatus ?? 503);
    },
    async write(request) {
      const url = new URL(request.url);
      if (url.pathname !== `${agileRoot}/${selected.path}`) return undefined;
      expect(request.method).toBe(selected.method);
      expect(url.search).toBe("");
      expect(request.jiraExperimental).toBe(
        selected.name === "jira.unmap-sprints" || selected.name === "jira.unmap-all-sprints"
          ? true
          : undefined,
      );
      const body = NATIVE_BODIES[selected.name];
      expect(request.bodyJson).toBe(body === undefined ? undefined : JSON.stringify(body));
      expect(++writes).toBe(1);
      const result = await fixture.ports.requests.agile(
        selected.path,
        selected.method,
        body,
        "none",
      );
      return result.ok
        ? response(result.items ?? result.body, result.status)
        : response({}, result.httpStatus ?? 503);
    },
  };
}
