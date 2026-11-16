import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
// eslint-disable-next-line no-control-regex -- bounded prose cannot carry terminal controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
const SPRINT_STATES: ReadonlySet<unknown> = new Set(["future", "active", "closed"]);

/** Jira uses int64 IDs; values that JavaScript cannot represent exactly are refused. */
export function agileId(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/u.test(value)) return undefined;
  return Number.isSafeInteger(Number(value)) ? value : undefined;
}
export function agileText(value: unknown, max = 255, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    value.length <= max &&
    !CONTROL.test(value)
  );
}
export function agileIssueKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,31}-[1-9]\d{0,15}$/u.test(value);
}
export function agileDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/u.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(value.slice(0, 10))
  );
}
export function agileBoard(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = agileId(raw?.id);
  if (
    raw === undefined ||
    id === undefined ||
    !agileText(raw.name) ||
    (raw.type !== "scrum" && raw.type !== "kanban")
  )
    return undefined;
  return { id, name: raw.name, type: raw.type };
}
function sprintOptionals(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["startDate", "endDate", "completeDate", "activatedDate"] as const) {
    const date = raw[key];
    if (date === undefined || date === null) continue;
    if (!agileDate(date)) return undefined;
    result[key] = date;
  }
  if (raw.originBoardId !== undefined) {
    const boardId = agileId(raw.originBoardId);
    if (boardId === undefined) return undefined;
    result.originBoardId = boardId;
  }
  if (raw.goal !== undefined && raw.goal !== null) {
    if (!agileText(raw.goal, 2048, true)) return undefined;
    result.goal = raw.goal;
  }
  return result;
}
export function agileSprint(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = agileId(raw?.id);
  if (
    raw === undefined ||
    id === undefined ||
    !agileText(raw.name) ||
    typeof raw.state !== "string" ||
    !SPRINT_STATES.has(raw.state)
  )
    return undefined;
  const optional = sprintOptionals(raw);
  return optional === undefined ? undefined : { id, name: raw.name, state: raw.state, ...optional };
}
function epicColor(value: unknown): CatalogJsonObject | undefined {
  if (value === undefined) return {};
  const key = asRecord(value)?.key;
  return typeof key === "string" && /^color_(?:[1-9]|1[0-4])$/u.test(key)
    ? { color: key }
    : undefined;
}
export function agileEpic(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const id = agileId(raw?.id);
  if (
    raw === undefined ||
    id === undefined ||
    !agileIssueKey(raw.key) ||
    !agileText(raw.name) ||
    !agileText(raw.summary) ||
    typeof raw.done !== "boolean"
  )
    return undefined;
  const result: Record<string, CatalogJsonValue> = {
    id,
    key: raw.key,
    name: raw.name,
    summary: raw.summary,
    done: raw.done,
  };
  const color = epicColor(raw.color);
  return color === undefined ? undefined : { ...result, ...color };
}
function columnBounds(raw: Record<string, unknown>): CatalogJsonObject | undefined {
  const result: Record<string, CatalogJsonValue> = {};
  for (const key of ["min", "max"] as const) {
    const bound = raw[key];
    if (bound === undefined) continue;
    if (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 0) return undefined;
    result[key] = bound;
  }
  return result;
}
function column(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const statuses = asArray(raw?.statuses);
  if (raw === undefined || !agileText(raw.name) || statuses === undefined || statuses.length > 100)
    return undefined;
  const ids = statuses.map((status) => agileId(asRecord(status)?.id));
  if (ids.includes(undefined)) return undefined;
  const result: Record<string, CatalogJsonValue> = {
    name: raw.name,
    statusIds: ids.filter((id) => id !== undefined),
  };
  const bounds = columnBounds(raw);
  return bounds === undefined ? undefined : { ...result, ...bounds };
}
function configurationColumns(value: unknown): readonly CatalogJsonObject[] | undefined {
  const columns = asArray(asRecord(value)?.columns);
  if (columns === undefined || columns.length > 100) return undefined;
  const projected = columns.map(column);
  return projected.includes(undefined)
    ? undefined
    : projected.filter((entry) => entry !== undefined);
}
export function agileBoardConfiguration(value: unknown): CatalogJsonObject | undefined {
  const raw = asRecord(value);
  const board = agileBoard(value);
  const filterId = agileId(asRecord(raw?.filter)?.id);
  const columns = configurationColumns(raw?.columnConfig);
  if (raw === undefined || board === undefined || filterId === undefined || columns === undefined)
    return undefined;
  return { ...board, filterId, columns };
}
