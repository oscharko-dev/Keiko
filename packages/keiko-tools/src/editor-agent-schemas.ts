import type { ToolDefinition } from "@oscharko-dev/keiko-contracts";

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value);
}

const POSITION_SCHEMA = objectSchema(
  {
    line: { type: "integer", minimum: 0 },
    character: { type: "integer", minimum: 0 },
  },
  ["line", "character"],
);

const RANGE_SCHEMA = objectSchema(
  {
    start: POSITION_SCHEMA,
    end: POSITION_SCHEMA,
  },
  ["start", "end"],
);

const DOCUMENT_VERSION_SCHEMA = objectSchema(
  {
    sizeBytes: { type: "integer", minimum: 0 },
    modifiedAt: { type: "integer", minimum: 0 },
    contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  },
  ["sizeBytes", "modifiedAt", "contentHash"],
);

const TEXT_EDIT_SCHEMA = objectSchema(
  {
    range: RANGE_SCHEMA,
    newText: { type: "string" },
  },
  ["range", "newText"],
);

const IDEMPOTENCY_KEY_SCHEMA = { type: "string", minLength: 1 };

const CHANGESET_FILE_SCHEMA = {
  ...objectSchema(
    {
      file: { type: "string", minLength: 1 },
      expectedDocumentVersion: DOCUMENT_VERSION_SCHEMA,
      expectedContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    },
    ["file"],
  ),
  anyOf: [{ required: ["expectedDocumentVersion"] }, { required: ["expectedContentHash"] }],
};

const SNAPSHOT_PARAMETERS = objectSchema(
  {
    sessionId: { type: "string", minLength: 1 },
    textMode: {
      type: "string",
      enum: ["none", "selection", "activeFile"],
      default: "none",
    },
    maxBytes: { type: "integer", minimum: 0 },
  },
  ["sessionId"],
);

const NAVIGATE_PARAMETERS = {
  ...objectSchema(
    {
      sessionId: { type: "string", minLength: 1 },
      idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
      type: { type: "string", enum: ["openFile", "focusTab", "setSelection"] },
      file: { type: "string", minLength: 1 },
      paneId: { type: "string", minLength: 1 },
      selection: RANGE_SCHEMA,
    },
    ["sessionId", "idempotencyKey", "type"],
  ),
  oneOf: [
    { properties: { type: { const: "openFile" } }, required: ["file"] },
    { properties: { type: { const: "focusTab" } }, required: ["file"] },
    { properties: { type: { const: "setSelection" } }, required: ["selection"] },
  ],
};

const EDIT_PARAMETERS = {
  ...objectSchema(
    {
      sessionId: { type: "string", minLength: 1 },
      idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
      type: { type: "string", enum: ["applyTextEdits", "applyPatch"] },
      file: { type: "string", minLength: 1 },
      expectedDocumentVersion: DOCUMENT_VERSION_SCHEMA,
      expectedContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      textEdits: { type: "array", items: TEXT_EDIT_SCHEMA },
      patch: { type: "string" },
    },
    ["sessionId", "idempotencyKey", "type", "file"],
  ),
  allOf: [
    {
      oneOf: [
        { properties: { type: { const: "applyTextEdits" } }, required: ["textEdits"] },
        { properties: { type: { const: "applyPatch" } }, required: ["patch"] },
      ],
    },
    {
      anyOf: [{ required: ["expectedDocumentVersion"] }, { required: ["expectedContentHash"] }],
    },
  ],
};

const CHANGESET_PARAMETERS = objectSchema(
  {
    sessionId: { type: "string", minLength: 1 },
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    patch: { type: "string", minLength: 1 },
    files: { type: "array", minItems: 1, items: CHANGESET_FILE_SCHEMA },
    selectedFiles: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", minLength: 1 },
    },
  },
  ["sessionId", "idempotencyKey", "patch", "files"],
);

// Issue #2214 — the closed VerificationKind set (test | targeted-test | typecheck | lint | build).
// `targetPath` is the workspace-relative file for the `targeted-test` kind; the server re-checks
// containment and the deny-list. No free-form argv or open-ended kind is ever accepted.
const REQUEST_VERIFICATION_PARAMETERS = objectSchema(
  {
    sessionId: { type: "string", minLength: 1 },
    kind: {
      type: "string",
      enum: ["test", "targeted-test", "typecheck", "lint", "build"],
    },
    targetPath: { type: "string", minLength: 1 },
  },
  ["sessionId", "kind"],
);

const LANGUAGE_DIAGNOSTIC_SCHEMA = objectSchema(
  {
    range: RANGE_SCHEMA,
    severity: { type: "string", enum: ["error", "warning", "info", "hint"] },
    message: { type: "string", minLength: 1 },
    source: { type: "string", minLength: 1 },
    code: { type: "string", minLength: 1 },
  },
  ["range", "severity", "message", "source"],
);

const NAVIGATE_SYMBOL_PARAMETERS = objectSchema(
  {
    sessionId: { type: "string", minLength: 1 },
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    file: { type: "string", minLength: 1 },
    operation: {
      type: "string",
      enum: [
        "diagnostics",
        "definition",
        "typeDefinition",
        "implementation",
        "references",
        "callHierarchy",
        "inlayHints",
        "renamePrepare",
        "codeActions",
        "signatureHelp",
      ],
    },
    position: POSITION_SCHEMA,
    languageId: { type: "string", minLength: 1 },
    text: { type: "string" },
    range: RANGE_SCHEMA,
    diagnostics: { type: "array", items: LANGUAGE_DIAGNOSTIC_SCHEMA },
  },
  ["sessionId", "idempotencyKey", "file", "operation", "position"],
);

const SEARCH_WORKSPACE_PARAMETERS = objectSchema(
  {
    sessionId: { type: "string", minLength: 1 },
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    query: { type: "string", minLength: 1, maxLength: 200 },
    mode: { type: "string", enum: ["text", "symbol"] },
    caseSensitive: { type: "boolean", default: false },
    includeGlobs: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32 },
    excludeGlobs: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32 },
    maxResults: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    scopePath: { type: "string", minLength: 1 },
  },
  ["sessionId", "idempotencyKey", "query", "mode"],
);

const GIT_CONTEXT_PARAMETERS = objectSchema(
  {
    sessionId: { type: "string", minLength: 1 },
    idempotencyKey: IDEMPOTENCY_KEY_SCHEMA,
    path: { type: "string", minLength: 1 },
    aspects: {
      type: "array",
      items: { type: "string", enum: ["status", "diff", "blame"] },
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    },
  },
  ["sessionId", "idempotencyKey", "path", "aspects"],
);

export const EDITOR_AGENT_TOOL_DEFINITIONS: readonly ToolDefinition[] = deepFreeze([
  {
    name: "editor_list_sessions",
    description: "List active governed editor sessions and their bounded snapshots.",
    parameters: objectSchema({}, []),
  },
  {
    name: "editor_snapshot",
    description: "Read one governed editor snapshot. Text is omitted unless explicitly requested.",
    parameters: SNAPSHOT_PARAMETERS,
  },
  {
    name: "editor_navigate",
    description:
      "Queue an openFile, focusTab, or setSelection action for a governed editor session.",
    parameters: NAVIGATE_PARAMETERS,
  },
  {
    name: "editor_navigate_symbol",
    description:
      "Resolve a TypeScript/JavaScript definition, references, rename candidates, code actions, or signature help through the governed editor action queue.",
    parameters: NAVIGATE_SYMBOL_PARAMETERS,
  },
  {
    name: "editor_search_workspace",
    description:
      "Search workspace text or symbols through the governed editor action queue with bounded ranked results.",
    parameters: SEARCH_WORKSPACE_PARAMETERS,
  },
  {
    name: "editor_git_context",
    description:
      "Read bounded, redacted source-control status, diff-vs-HEAD, and blame for one workspace file through the governed editor action queue. Read-only; never mutates git state.",
    parameters: GIT_CONTEXT_PARAMETERS,
  },
  {
    name: "editor_propose_edit",
    description:
      "Propose applyTextEdits or one single-file applyPatch action. The server owns validation and governance.",
    parameters: EDIT_PARAMETERS,
  },
  {
    name: "editor_propose_changeset",
    description:
      "Propose one governed applyChangeset action. The server validates the complete multi-file transaction.",
    parameters: CHANGESET_PARAMETERS,
  },
  {
    name: "editor_request_verification",
    description:
      "Request one governed verification run (test | targeted-test | typecheck | lint | build) for a session's workspace. The server classifies and gates it through the Authority Envelope before any sandboxed run starts, then returns a redacted report.",
    parameters: REQUEST_VERIFICATION_PARAMETERS,
  },
]);
