// ADR-0182 D5 (#4136): the Keiko for Quality Counter-checker's own registration set. A counter-check
// session is a bounded, read-only child session (ADR-0175 D2) with a reserved profile of its own:
// three read tools over the reviewed head commit and one verdict tool, nothing else. The child
// profile (`keiko_child_workspace_read`) is unchanged; these aliases are distinct canonical
// identities so neither profile can ever advertise the other's tools.
import {
  COUNTER_CHECK_REASON_CODES,
  COUNTER_CHECK_VERDICTS,
  REVIEW_EVIDENCE_MAX_ENTRIES,
  REVIEW_EVIDENCE_ROLES,
  REVIEW_LINE_MAX,
} from "@oscharko-dev/keiko-contracts/runtime/pull-request-review";
import { TOOL_CATALOG_LIMITS } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { DEFAULT_SANDBOX_POLICY } from "@oscharko-dev/keiko-contracts/runtime/tools";
import type { CatalogJsonObject } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import { createToolRef } from "./identity.js";
import { createToolDescriptor } from "./descriptor.js";
import { NATIVE_TOOL_CATALOG_RUNTIME } from "./dialect.js";
import type { CatalogRegistrationSet, CatalogSetEntry } from "./composer.js";

/** The reserved profile of a counter-check session. */
export const REVIEW_COUNTER_CHECK_PROFILE = { id: "review-counter-check", version: 1 } as const;

/** The four aliases a counter-check session is offered, in registration order. */
export const REVIEW_COUNTER_CHECK_TOOL_ALIASES = {
  read: "keiko_counter_check_read",
  discover: "keiko_counter_check_discover",
  search: "keiko_counter_check_search",
  verdict: "keiko_counter_check_verdict",
} as const;

/** The handler each alias binds to; one port per tool, contract version 1. */
export const REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS = {
  read: { id: "review-counter-check-read-port", contractVersion: 1 },
  discover: { id: "review-counter-check-discover-port", contractVersion: 1 },
  search: { id: "review-counter-check-search-port", contractVersion: 1 },
  verdict: { id: "review-counter-check-verdict-port", contractVersion: 1 },
} as const;

type CounterCheckTool = keyof typeof REVIEW_COUNTER_CHECK_TOOL_ALIASES;

const PATH_SCHEMA = { type: "string", minLength: 1, maxLength: 512 } as const;
const LINE_SCHEMA = { type: "integer", minimum: 1, maximum: REVIEW_LINE_MAX } as const;

function objectSchema(
  properties: CatalogJsonObject,
  required: readonly string[],
): CatalogJsonObject {
  return { type: "object", properties, required: [...required], additionalProperties: false };
}

const INPUT_SCHEMAS: Readonly<Record<CounterCheckTool, CatalogJsonObject>> = {
  read: objectSchema({ relativePath: PATH_SCHEMA, startLine: LINE_SCHEMA, endLine: LINE_SCHEMA }, [
    "relativePath",
  ]),
  discover: objectSchema({ directory: { type: "string", maxLength: 512 } }, []),
  search: objectSchema({ literal: { type: "string", minLength: 2, maxLength: 200 } }, ["literal"]),
  verdict: objectSchema(
    {
      verdict: { type: "string", enum: [...COUNTER_CHECK_VERDICTS] },
      reasonCode: { type: "string", enum: [...COUNTER_CHECK_REASON_CODES] },
      evidence: {
        type: "array",
        minItems: 0,
        maxItems: REVIEW_EVIDENCE_MAX_ENTRIES,
        items: objectSchema(
          {
            file: PATH_SCHEMA,
            startLine: LINE_SCHEMA,
            endLine: LINE_SCHEMA,
            role: { type: "string", enum: [...REVIEW_EVIDENCE_ROLES] },
          },
          ["file", "startLine", "endLine", "role"],
        ),
      },
    },
    ["verdict", "reasonCode", "evidence"],
  ),
};

const DESCRIPTIONS: Readonly<Record<CounterCheckTool, string>> = {
  read: "Read one file of the reviewed head commit as numbered lines, optionally a line window.",
  discover: "List the files and directories of one directory of the reviewed head commit.",
  search:
    "Search the reviewed head commit for a literal text and return the matching files and lines.",
  verdict:
    "Record your one verdict on the candidate finding, with your own code evidence. " +
    "Call it exactly once; text outside this tool is ignored.",
};

function entryFor(tool: CounterCheckTool): CatalogSetEntry {
  const alias = REVIEW_COUNTER_CHECK_TOOL_ALIASES[tool];
  return {
    alias,
    descriptor: createToolDescriptor({
      toolRef: createToolRef(`keiko.review.counterchecker.${tool}`, 1),
      description: DESCRIPTIONS[tool],
      inputSchema: INPUT_SCHEMAS[tool],
      resultSchema: { type: "string", maxLength: TOOL_CATALOG_LIMITS.maxStringBytes },
      effects: ["workspace-read"],
      actionMapping: [{ action: alias, effects: ["workspace-read"] }],
      policyReferences: ["workspace-read"],
      handlerRequirement: REVIEW_COUNTER_CHECK_HANDLER_REQUIREMENTS[tool],
      bounds: {
        maxArgumentBytes: TOOL_CATALOG_LIMITS.maxArgumentBytes,
        maxResultBytes: TOOL_CATALOG_LIMITS.maxResultBytes,
        maxResultCount: 1,
        maxDurationMs: DEFAULT_SANDBOX_POLICY.defaultTimeoutMs,
      },
      idempotency: "read-only",
      cancellation: "before-effect",
    }),
  };
}

/** The `review-counter-check` registration set: three head-commit reads and one verdict tool. */
export function reviewCounterCheckRegistrationSet(): CatalogRegistrationSet {
  return {
    profile: REVIEW_COUNTER_CHECK_PROFILE,
    adapterDialect: { id: "child-agent-json-schema", version: 1 },
    adapterRuntime: NATIVE_TOOL_CATALOG_RUNTIME,
    nativeExtensions: [],
    compatibility: [],
    entries: (["read", "discover", "search", "verdict"] as const).map(entryFor),
  };
}
