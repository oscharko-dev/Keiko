import { expect } from "vitest";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  AGILE_PLANNING_FIXTURE_CASES,
  agilePlanningFixture,
} from "./jira-agile-planning-fixture.js";
import { response } from "./jira-managed-remote.js";

type PlanningCase = (typeof AGILE_PLANNING_FIXTURE_CASES)[number];
const NATIVE_BODIES: Readonly<Record<PlanningCase["name"], CatalogJsonObject>> = {
  "jira.epic-remove-issues": { issues: ["10001"] },
  "jira.rank-epic": { rankBeforeEpic: "10002", rankCustomFieldId: 10019 },
  "jira.rank-issues": { rankBeforeIssue: "10002", rankCustomFieldId: 10019, issues: ["10001"] },
  "jira.set-issue-estimation": { value: "5" },
};
function platformPath(path: string): boolean {
  return path === "myself" || path === "field" || /^issue\/(?:SYN-[123]|1000[123])\?/u.test(path);
}
function agilePath(path: string): boolean {
  return (
    path === "board/7/configuration" ||
    path.startsWith("board/7/issue?") ||
    /^epic\/1000[123]$/u.test(path) ||
    /^issue\/1000[123](?:\?|\/estimation\?)/u.test(path)
  );
}
interface PlanningTransportFixture {
  readonly read: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly write: (
    request: AtlassianHttpBodyRequest,
  ) => Promise<AtlassianHttpBodyResult | undefined>;
  readonly snapshot: () => CatalogJsonObject;
}
type PlanningFixture = ReturnType<typeof agilePlanningFixture>;
type PlanningOutcome = Awaited<ReturnType<PlanningFixture["ports"]["requests"]["agile"]>>;

function planningResponse(result: PlanningOutcome): AtlassianHttpBodyResult {
  return result.ok
    ? response(result.items ?? result.body, result.status)
    : response({}, result.httpStatus ?? 503);
}

function readPath(
  request: AtlassianHttpBodyRequest,
  platformRoot: string,
  agileRoot: string,
): { readonly platform: boolean; readonly path: string } | undefined {
  const url = new URL(request.url);
  const platform = url.pathname.startsWith(`${platformRoot}/`);
  if (!platform && !url.pathname.startsWith(`${agileRoot}/`)) return undefined;
  const path = `${url.pathname.slice((platform ? platformRoot : agileRoot).length + 1)}${url.search}`;
  if (!(platform ? platformPath(path) : agilePath(path))) return undefined;
  return { platform, path };
}

async function planningRead(
  native: PlanningFixture,
  request: AtlassianHttpBodyRequest,
  roots: readonly [string, string],
): Promise<AtlassianHttpBodyResult | undefined> {
  const target = readPath(request, roots[0], roots[1]);
  if (target === undefined) return undefined;
  const { platform, path } = target;
  expect(request.method).toBe("GET");
  expect(request.bodyJson).toBeUndefined();
  expect(request.jiraExperimental).toBeUndefined();
  const port = platform ? native.ports.requests.issue : native.ports.requests.agile;
  return planningResponse(
    await port(path, "GET", undefined, path === "field" ? "json-array" : "json"),
  );
}

/** Fixed roots and literal bodies exercise the real serialized native request against the
 * already independent planning fixture. Separate platform/Agile ports are retained. */
export function agilePlanningTransportFixture(
  platformRoot: string,
  agileRoot: string,
  selected: PlanningCase,
  actorKey = "synthetic-actor",
): PlanningTransportFixture {
  const native = agilePlanningFixture();
  native.actor.key = actorKey;
  let writes = 0;
  return {
    snapshot: native.snapshot,
    read: (request) => planningRead(native, request, [platformRoot, agileRoot]),
    async write(request: AtlassianHttpBodyRequest): Promise<AtlassianHttpBodyResult | undefined> {
      const url = new URL(request.url);
      if (`${url.pathname}${url.search}` !== `${agileRoot}/${selected.path}`) return undefined;
      expect(request.method).toBe(selected.method);
      expect(request.jiraExperimental).toBeUndefined();
      const body = NATIVE_BODIES[selected.name];
      expect(request.bodyJson).toBe(JSON.stringify(body));
      expect(++writes).toBe(1);
      return planningResponse(
        await native.ports.requests.agile(selected.path, selected.method, body, "none"),
      );
    },
  };
}
