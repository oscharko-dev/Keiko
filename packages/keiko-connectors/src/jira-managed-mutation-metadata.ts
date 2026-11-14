import {
  isSafeAtlassianIdentifier,
  type AtlassianConnectorWriteFailureReason,
  type JiraFieldMetadata,
  type JiraMutationFailureDetail,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import type {
  CatalogJsonObject,
  CatalogJsonValue,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { asArray, asRecord } from "./atlassian-sync-classify.js";
import type {
  AtlassianWriteHttpOutcome,
  AtlassianWriteHttpRequest,
} from "./atlassian-write-http.js";
import {
  JIRA_METADATA_MAX_FIELDS,
  parseJiraFieldMetadata,
  type JiraMetadataResult,
} from "./jira-field-metadata.js";
import { jiraMetadataPageLast, parseJiraFieldMap } from "./jira-managed-metadata.js";

/** Fixed native owners may serialize a complete JSON value; the HTTP owner still enforces method,
 * UTF-8 bytes, custody, authority and multipart exclusion on the same serialized body channel.
 */
export type JiraMutationBody = Readonly<Record<string, unknown>> | CatalogJsonValue;
export type JiraMutationRequest = (
  path: string,
  method?: AtlassianWriteHttpRequest["method"],
  body?: JiraMutationBody,
  expect?: AtlassianWriteHttpRequest["expect"],
  upload?: AtlassianWriteHttpRequest["upload"],
) => Promise<AtlassianWriteHttpOutcome>;
export type JiraMutationMetadata =
  | { readonly ok: true; readonly fields: readonly JiraFieldMetadata[] }
  | {
      readonly ok: false;
      readonly reason: AtlassianConnectorWriteFailureReason;
      /** The sentence of a refusal Keiko itself decided, e.g. a transition that is not offered (#4357). */
      readonly detail?: JiraMutationFailureDetail;
    };
const MALFORMED = { ok: false, reason: "malformed-payload" } as const;
function parsedMetadata(parsed: JiraMetadataResult): JiraMutationMetadata {
  return parsed.ok
    ? parsed
    : {
        ok: false,
        reason: parsed.reason === "bounds-exceeded" ? parsed.reason : "malformed-payload",
      };
}
interface CreatePage {
  readonly values: readonly unknown[];
  readonly total: number | undefined;
  readonly last: boolean;
}
function createPage(
  response: Extract<AtlassianWriteHttpOutcome, { ok: true }>,
  start: number,
): CreatePage | undefined {
  const body = response.body;
  if (response.status !== 200 || body === undefined) return undefined;
  const values = asArray(body.values);
  const last =
    values === undefined ? undefined : jiraMetadataPageLast(body, values.length, start, 100);
  if (values === undefined || last === undefined) return undefined;
  return {
    values,
    total: typeof body.total === "number" ? body.total : undefined,
    last,
  };
}
export async function jiraCreateMutationMetadata(
  request: JiraMutationRequest,
  projectId: string,
  issueTypeId: string,
): Promise<JiraMutationMetadata> {
  const values: unknown[] = [];
  let total: number | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const response = await request(
      `issue/createmeta/${projectId}/issuetypes/${issueTypeId}?startAt=${String(values.length)}&maxResults=100`,
    );
    if (!response.ok) return response;
    const page = createPage(response, values.length);
    if (page === undefined || (total !== undefined && page.total !== total)) return MALFORMED;
    total = page.total;
    if (values.length + page.values.length > JIRA_METADATA_MAX_FIELDS)
      return { ok: false, reason: "bounds-exceeded" };
    values.push(...page.values);
    if (page.last) return parsedMetadata(parseJiraFieldMetadata(values));
  }
  return { ok: false, reason: "bounds-exceeded" };
}
export async function jiraEditMutationMetadata(
  request: JiraMutationRequest,
  issueKey: string,
): Promise<JiraMutationMetadata> {
  const response = await request(`issue/${encodeURIComponent(issueKey)}/editmeta`);
  if (!response.ok) return response;
  return response.status === 200 && response.body !== undefined
    ? parsedMetadata(parseJiraFieldMap(response.body.fields))
    : MALFORMED;
}
export type JiraTransitionMutationMetadata =
  | Extract<JiraMutationMetadata, { ok: false }>
  | {
      readonly ok: true;
      readonly fields: readonly JiraFieldMetadata[];
      readonly targetStatusId: string;
      readonly transitionName?: string;
      readonly targetStatusName?: string;
    };
function selectedTransitionMetadata(value: unknown): JiraTransitionMutationMetadata {
  const transition = asRecord(value);
  const target = asRecord(transition?.to);
  const targetStatusId = target?.id;
  if (!isSafeAtlassianIdentifier(targetStatusId)) return MALFORMED;
  const parsed = parsedMetadata(parseJiraFieldMap(transition?.fields));
  if (!parsed.ok) return parsed;
  const transitionName = transition?.name;
  const targetStatusName = target?.name;
  return {
    ...parsed,
    targetStatusId,
    ...(typeof transitionName === "string" ? { transitionName } : {}),
    ...(typeof targetStatusName === "string" ? { targetStatusName } : {}),
  };
}
export async function jiraTransitionMutationMetadata(
  request: JiraMutationRequest,
  issueKey: string,
  transitionId: string,
): Promise<JiraTransitionMutationMetadata> {
  const response = await request(
    `issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`,
  );
  if (!response.ok) return response;
  const transitions = asArray(response.body?.transitions);
  if (response.status !== 200 || transitions === undefined || transitions.length > 1000)
    return MALFORMED;
  const matches = transitions.map(asRecord).filter((item) => item?.id === transitionId);
  if (matches.length === 0)
    return {
      ok: false,
      reason: "invalid-transition",
      detail: {
        fieldId: "transitionId",
        messages: [
          "The transition id is not available for this issue in its current status: read jira.transitions for the ids it offers now. Nothing was changed.",
        ],
      },
    };
  return matches.length === 1 ? selectedTransitionMetadata(matches[0]) : MALFORMED;
}
/** The bound on a known-target receipt that is journaled before any native request is sent. */
export const JIRA_MUTATION_RECEIPT_MAX_BYTES = 16384;
export function jiraMutationReceiptFits(receipt: unknown): boolean {
  return (
    new TextEncoder().encode(JSON.stringify(receipt)).byteLength <= JIRA_MUTATION_RECEIPT_MAX_BYTES
  );
}
/**
 * The one admission order every fixed-effect mutation shares: admit against the live native state,
 * stop there for a dry check, admit again immediately before the effect, then dispatch exactly once.
 */
export async function runAdmittedMutation<Attempt>(
  admit: () => Promise<Attempt | undefined>,
  check: boolean,
  checked: Attempt,
  dispatch: () => Promise<Attempt>,
): Promise<Attempt> {
  const refused = await admit();
  if (refused !== undefined) return refused;
  if (check) return checked;
  const current = await admit();
  return current ?? dispatch();
}
/** The fixed refusals, receipt and dry-check result one fixed-effect mutation family declares once. */
export interface FixedMutationSpec<Input, Receipt, Attempt> {
  readonly refuse: (message: string) => Attempt;
  readonly invalid: string;
  readonly oversize: string;
  readonly receiptOf: (input: Input) => Receipt;
  readonly checked: Attempt;
}
/** A fixed-effect mutation from parsed input to its single dispatch, with the shared receipt bound. */
export async function runFixedMutation<Input, Receipt, Attempt>(
  spec: FixedMutationSpec<Input, Receipt, Attempt>,
  input: Input | undefined,
  check: boolean,
  run: {
    readonly admit: (input: Input, receipt: Receipt) => Promise<Attempt | undefined>;
    readonly dispatch: (input: Input, receipt: Receipt) => Promise<Attempt>;
  },
): Promise<Attempt> {
  if (input === undefined) return spec.refuse(spec.invalid);
  const receipt = spec.receiptOf(input);
  if (!jiraMutationReceiptFits(receipt)) return spec.refuse(spec.oversize);
  return runAdmittedMutation(
    () => run.admit(input, receipt),
    check,
    spec.checked,
    () => run.dispatch(input, receipt),
  );
}
/** The exported executor of one fixed-effect mutation family: parse, bound, admit twice, dispatch once. */
export function fixedMutationExecutor<Operation, Input, Receipt, Attempt>(
  spec: FixedMutationSpec<Input, Receipt, Attempt>,
  parse: (operation: Operation, args: CatalogJsonObject) => Input | undefined,
  run: {
    readonly admit: (request: JiraMutationRequest, input: Input) => Promise<Attempt | undefined>;
    readonly dispatch: (
      request: JiraMutationRequest,
      input: Input,
      receipt: Receipt,
    ) => Promise<Attempt>;
  },
): (
  operation: Operation,
  args: CatalogJsonObject,
  request: JiraMutationRequest,
  check?: boolean,
) => Promise<Attempt> {
  return (operation, args, request, check = false) =>
    runFixedMutation(spec, parse(operation, args), check, {
      admit: (input) => run.admit(request, input),
      dispatch: (input, receipt) => run.dispatch(request, input, receipt),
    });
}
