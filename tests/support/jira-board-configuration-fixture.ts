import { expect } from "vitest";
import type {
  AtlassianHttpBodyRequest,
  AtlassianHttpBodyResult,
} from "@oscharko-dev/keiko-connectors";
import { response } from "./jira-managed-remote.js";

const BOARD_CONTEXT = {
  boardId: "7",
  expectedActorKey: "synthetic-actor",
  expectedBoardName: "Reviewed board",
  expectedBoardType: "scrum",
  expectedFilterId: "42",
} as const;
export const BOARD_CONFIGURATION_FIXTURE_CASES = [
  {
    tool: "jira.delete-board",
    method: "DELETE",
    path: "/board/7",
    expectedOutcome: "succeeded-unconfirmed",
    args: BOARD_CONTEXT,
    expectedReceipt: {
      boardId: "7",
      filterId: "42",
      userKey: "synthetic-actor",
      boardPresent: false,
    },
  },
  {
    tool: "jira.set-board-refined-velocity",
    method: "PUT",
    path: "/board/7/settings/refined-velocity",
    expectedOutcome: "succeeded",
    args: { ...BOARD_CONTEXT, expectedValue: true, value: false },
    expectedReceipt: {
      boardId: "7",
      filterId: "42",
      userKey: "synthetic-actor",
      refinedVelocityEnabled: false,
    },
  },
] as const;
type BoardCase = (typeof BOARD_CONFIGURATION_FIXTURE_CASES)[number];

interface BoardTransportFixture {
  readonly read: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly write: (request: AtlassianHttpBodyRequest) => AtlassianHttpBodyResult | undefined;
  readonly snapshot: () => {
    readonly boardPresent: boolean;
    readonly refinedVelocityEnabled: boolean;
    readonly writes: number;
  };
}
interface BoardState {
  boardPresent: boolean;
  refinedVelocityEnabled: boolean;
  writes: number;
}

const BOARD = {
  id: 7,
  name: "Reviewed board",
  type: "scrum",
  filter: { id: 42 },
  columnConfig: { columns: [] },
};

function boardRead(
  state: BoardState,
  request: AtlassianHttpBodyRequest,
  roots: readonly [string, string],
): AtlassianHttpBodyResult | undefined {
  const [platformRoot, agileRoot] = roots;
  const url = new URL(request.url);
  expect(url.search).toBe("");
  if (url.pathname === `${platformRoot}/myself`)
    return response({ key: "synthetic-actor", name: "synthetic-user", active: true });
  if (
    url.pathname === `${agileRoot}/board/7/configuration` ||
    url.pathname === `${agileRoot}/board/7`
  )
    return state.boardPresent ? response(BOARD) : response({}, 404);
  if (url.pathname === `${agileRoot}/board/7/settings/refined-velocity`)
    return state.boardPresent
      ? response({ value: state.refinedVelocityEnabled })
      : response({}, 404);
  return undefined;
}

function boardWrite(
  state: BoardState,
  request: AtlassianHttpBodyRequest,
  agileRoot: string,
  selected: BoardCase,
  requestedValue: boolean,
): AtlassianHttpBodyResult | undefined {
  const url = new URL(request.url);
  if (url.pathname !== `${agileRoot}${selected.path}`) return undefined;
  expect(request.method).toBe(selected.method);
  expect(url.search).toBe("");
  state.writes++;
  expect(state.writes).toBe(1);
  if (selected.tool === "jira.delete-board") {
    expect(request.bodyJson).toBeUndefined();
    state.boardPresent = false;
  } else {
    expect(request.bodyJson).toBe(JSON.stringify({ value: requestedValue }));
    state.refinedVelocityEnabled = requestedValue;
  }
  return response(undefined, 204);
}

/** Independent native actor, configuration and BooleanSettingBean responses. No visible-board
 * collection is fabricated as proof of deletion, and zero-like/false values remain Booleans. */
export function boardConfigurationTransportFixture(
  platformRoot: string,
  agileRoot: string,
  selected: BoardCase,
  requestedValue = false,
): BoardTransportFixture {
  const state: BoardState = {
    boardPresent: true,
    refinedVelocityEnabled: !requestedValue,
    writes: 0,
  };
  return {
    snapshot: () => ({ ...state }),
    read: (request) => boardRead(state, request, [platformRoot, agileRoot]),
    write: (request) => boardWrite(state, request, agileRoot, selected, requestedValue),
  };
}
