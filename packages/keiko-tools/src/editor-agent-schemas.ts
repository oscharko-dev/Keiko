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
