# ADR-0013: UI-Local SQLite Persistence for Projects and Chats

## Status

Accepted

Decided before implementation begins (issue #62 requires the ADR before implementation).
This ADR defines the storage engine, flag-enablement strategy, module boundary, schema,
migration discipline, route contract, path-validation policy, and security posture for the
UI-local project and chat persistence layer. Implementation lands under `src/ui/store/**`
(new module), `tests/ui/**` (new tests), `ui/lib/**` (frontend client stubs), and
`vitest.config.ts` (one flag addition); this ADR adds no code.

## Context

Issue #62 adds the first stateful persistence surface for the local Keiko UI: **projects**
(identified by workspace path) and **chats** (associated with a project, with messages and
workflow references). Issue #61 is the parent epic. Without persistence, every `keiko ui`
session is ephemeral — projects are not remembered, chat history is lost, and a returning
developer cannot see what workflows they ran against which workspaces. Persistence is the
foundational requirement for the UI to be useful beyond a single session.

Five forces shape the design.

**The zero-new-runtime-dependency invariant is load-bearing.** ADR-0011 D1 explicitly chose
`output: "export"` + a hand-written Node BFF **because** the zero-runtime-dependency invariant
(`dependencies: {}`) keeps all seven required CI checks lean and green: `npm audit
--audit-level=high`, `npm sbom --omit dev`, `dependency-review` (license + vulnerability gate),
and the package-surface review. A SQLite library shipped as a runtime dependency (e.g.
`better-sqlite3`) would expand the audited, shipped dependency tree — increasing the CVE surface,
adding a native-addon compile risk, and widening the SBOM — for a pilot with a regulated
supply-chain posture. The decision on storage engine must reconcile "real SQLite semantics" with
"zero new runtime dependencies."

**`node:sqlite` exists in Node 22.x and is the reconciliation point.** The project pins
`engines: ">=22"` and CI runs `node-version: "22.x"` (currently resolving to v22.22.3 on the
CI runner, matching the local v22.22.3). The built-in `node:sqlite` module (`DatabaseSync`,
`StatementSync`) is present in Node 22.x. On Node 22.22.x (the effective lower bound in
practice, given the CI pin), the module loads **without any runtime flag** and emits only an
`ExperimentalWarning`; the `--experimental-sqlite` flag was required on earlier 22.0–22.11
patch builds and remains useful for **suppressing that warning** in test output. On Node 23.4+
and Node 24, `node:sqlite` is fully stable. Using the built-in preserves `dependencies: {}`
entirely — it is not a dependency at all.

**The BFF already owns a structured `UiHandlerDeps` injection surface.** `src/ui/deps.ts`
(ADR-0011 D5) wires the `EvidenceStore`, `RunRegistry`, `Redactor`, `ModelPortFactory`, config,
and env into `UiHandlerDeps` and passes them through every handler. A `UiStore` (the
persistence port for this issue) slots into exactly the same pattern with an injectable DB path
option, mirroring how `evidenceDir` is resolved in `buildUiHandlerDeps`.

**The static-export constraint governs the route contract.** ADR-0011 D1 established that the
Next static export has no runtime `[id]` dynamic routes. ADR-0011 D5 records that the twelve
existing routes are the stable contract and evolution is **additive only, no breaking change
without a superseding ADR**. The new project and chat routes must be additive to that contract
and must address resources via **query parameters + HTTP method** (not path parameters for mutable
entities), matching the established constraint.

**A new persistent write surface raises a new trust boundary.** Until now the BFF's only write
path was `POST /api/runs/:runId/apply` (ADR-0011 D8), which delegates entirely to the existing
workflow guards. The new routes write user-supplied project paths and chat titles directly to a
database. Path inputs in particular are security-sensitive: a path traversal, a remote URL, or a
null-byte injection must be rejected before any row is inserted. The DB must never be placed
inside a target repository and must use restrictive file permissions.

## Decision

### D1 — Storage engine: `node:sqlite` (built-in), zero new runtime dependencies

We will use the **built-in `node:sqlite` module** (`DatabaseSync`, `StatementSync`) as the
SQLite storage engine for the UI-local persistence layer. This is the decisive choice: it
preserves `dependencies: {}` and keeps all seven required CI checks (ADR-0002) unaffected,
because `node:sqlite` is a Node built-in and is not a dependency at all — it never appears in
`package.json`, `package-lock.json`, `npm audit`, `npm sbom --omit dev`, or `dependency-review`.

The module is present in all Node 22.x builds. The `@types/node@25.9.1` package (already in
`devDependencies`) ships `sqlite.d.ts` with `DatabaseSync` and `StatementSync`, so `tsc`
compiles a `node:sqlite` store with **no flag at compile time** — the flag is a runtime concern
only. On Node 22.22.x and later, the module loads without a runtime flag (emitting only an
`ExperimentalWarning`); on earlier 22.0–22.11 builds the `--experimental-sqlite` flag was
required. Because the `engines` pin is `">=22"` (not `">=22.22"`), the flag-enablement strategy
(D2) must be defensive.

**Reuse-unchanged invariant (explicit).** No file under
`src/{gateway,harness,workspace,tools,verification,workflows,audit}` is modified. All new code
is confined to `src/ui/**` (store module, route handlers, deps wiring), `tests/ui/**`,
`ui/lib/**` (frontend), `vitest.config.ts`, and `docs/adr/`. The acceptance gate is an empty
`git diff origin/dev -- src/{gateway,harness,workspace,tools,verification,workflows,audit}`.

### D2 — Flag-enablement strategy (three sites)

`node:sqlite` is experimental in Node 22.x and emits `ExperimentalWarning` when imported. Three
sites need explicit handling; the strategies differ by site.

**Site 1 — `keiko ui` runtime (`src/cli/ui.ts`).** We will add a detect-and-**re-exec** guard
at the top of the `keiko ui` entry path. If `node:sqlite` is not importable (throws
`ERR_UNKNOWN_BUILTIN_MODULE` or any other error), the guard re-spawns the current process with
`--experimental-sqlite` prepended to `process.execArgv`, inheriting stdio and forwarding
`SIGINT`/`SIGTERM` to the child process; the parent then propagates the child's exit code and
terminates. This covers Node 22.0–22.11 builds where the flag is required at runtime. On
22.22.x and later (where the module already loads) the guard exits immediately without spawning.
The re-exec is a single, self-contained guard function — not spread across the application. It
also handles the case where `keiko ui` is invoked directly (e.g. from CI smoke `node
dist/cli/index.js ui`) because the child inherits the same argv.

To avoid orphaned grandchild processes, the guard: (a) sets the child's `detached: false`
(default), (b) uses `stdio: 'inherit'`, (c) registers exactly one `SIGINT` and one `SIGTERM`
listener that signal the child then call `process.exit` — ensuring no second re-exec loop (the
child already has the flag, so the guard exits immediately on the child's first instruction).

**Site 2 — vitest (`npm test`, part of the required `ci` check).** We will add
`test.poolOptions.forks.execArgv: ['--experimental-sqlite',
'--disable-warning=ExperimentalWarning']` to `vitest.config.ts`. The `--experimental-sqlite`
flag ensures tests that import the store run on any Node 22.x build; `--disable-warning` keeps
test output clean on Node 22.22.x (where the flag is not required but the warning fires anyway
on import). The root `vitest.config.ts` already has `test.environment: "node"` and
`test.include: ["tests/**/*.test.ts"]`; this is a one-field addition to an existing
`defineConfig` call.

**Site 3 — `tsc`/build.** No flag is needed. TypeScript resolves `node:sqlite` through
`@types/node` at compile time; the flag is a runtime concept, invisible to the type checker.
The existing `npm run build` (`tsc` only) continues to work with no changes to `tsconfig.json`
or `package.json` scripts.

### D3 — Module boundary: `src/ui/store/**`

We will build the persistence layer as a dedicated module at `src/ui/store/**`. It is a **leaf
within the UI layer**: it is imported by `src/ui/deps.ts` and by route handlers, but it imports
nothing from the BFF's run/SSE/event machinery. It imports Node built-ins (`node:sqlite`,
`node:fs`, `node:path`, `node:os`) and nothing outside `src/ui/` (no harness, no audit, no
gateway). The module exports a typed `UiStore` port and a `createNodeUiStore(dbPath)` adapter
whose concrete implementation uses `DatabaseSync`.

```
src/ui/store/
  types.ts       — UiStore port, Project/Chat/ChatMessage/WorkflowRef types, typed errors
  errors.ts      — UiStoreError subclasses with stable codes (no stack traces)
  paths.ts       — resolveUiDbPath(explicit, env): string (mirrors src/audit/store.ts precedence)
  schema.ts      — SCHEMA_VERSION constant, CREATE TABLE statements, migration runner
  db.ts          — openDatabase(path): DatabaseSync, applyMigrations, file-permission hardening
  projects.ts    — listProjects, createProject, updateProject, deleteProject (SQL only)
  chats.ts       — listChats, createChat, updateChat, deleteChat (SQL only)
  messages.ts    — listMessages, createMessage (SQL only)
  validate.ts    — validateProjectPath, fail-closed, all rules in one place
  index.ts       — barrel re-exporting the public UiStore + factory
```

**No ad-hoc SQL in route handlers.** All SQL lives inside `src/ui/store/` modules. Route
handlers call typed methods on `UiStore`; they never construct SQL strings. This is a hard rule:
parameterized statements protect against SQL injection; enforcing the boundary prevents handlers
from adding ad-hoc queries that bypass that guarantee.

### D4 — `UiStore` port and `UiHandlerDeps` wiring

We will define a `UiStore` port (mirroring the `EvidenceStore` port in `src/audit/store.ts`)
that the concrete `createNodeUiStore` adapter implements. The port is the seam for testing.

```typescript
// src/ui/store/types.ts

export interface Project {
  readonly path: string;            // normalized absolute path (UNIQUE key)
  readonly name: string;            // display name (basename by default)
  readonly favorite: boolean;
  readonly createdAt: number;       // epoch ms
  readonly lastOpenedAt: number;    // epoch ms
}

export interface Chat {
  readonly id: string;              // opaque UUID
  readonly projectPath: string;     // FK → projects.path
  readonly title: string;
  readonly selectedModel: string;   // registry id ONLY (no provider details)
  readonly branchLabel: string | undefined;
  readonly status: "open" | "closed" | undefined;
  readonly createdAt: number;       // epoch ms
  readonly updatedAt: number;       // epoch ms
}

export interface ChatMessage {
  readonly id: string;              // opaque UUID
  readonly chatId: string;          // FK → chats.id
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly timestamp: number;       // epoch ms
  // Lightweight workflow reference columns (nullable). No evidence/SSE payload duplication.
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly workflowStatus: "pending" | "running" | "completed" | "failed" | undefined;
  readonly shortResult: string | undefined;  // ≤ 200 chars, redacted before persist
}

export interface UiStore {
  // Projects
  readonly listProjects: () => readonly Project[];
  readonly createProject: (path: string, name?: string) => Project;
  readonly updateProject: (path: string, patch: Partial<Pick<Project, "name" | "favorite" | "lastOpenedAt">>) => Project;
  readonly deleteProject: (path: string) => void;

  // Chats
  readonly listChats: (projectPath: string) => readonly Chat[];
  readonly createChat: (projectPath: string, title: string, selectedModel: string, opts?: { branchLabel?: string }) => Chat;
  readonly updateChat: (id: string, patch: Partial<Pick<Chat, "title" | "selectedModel" | "branchLabel" | "status">>) => Chat;
  readonly deleteChat: (id: string) => void;

  // Messages
  readonly listMessages: (chatId: string) => readonly ChatMessage[];
  readonly createMessage: (msg: Omit<ChatMessage, "id">) => ChatMessage;

  // Lifecycle
  readonly close: () => void;
}
```

`UiStore` is added to `UiHandlerDeps` in `src/ui/deps.ts` as `readonly store: UiStore` and
wired in `buildUiHandlerDeps` via `createNodeUiStore(resolveUiDbPath(...))`. Every test that
exercises store-dependent handlers injects an in-memory `UiStore` (the `createInMemoryUiStore`
factory built alongside the real adapter) and never touches the filesystem.

**DB path precedence (mirrors `resolveEvidenceDir`).** `resolveUiDbPath(explicit, env)` in
`src/ui/store/paths.ts`:

1. An `explicit` option (e.g. `--ui-db` / a test injection).
2. The `KEIKO_UI_DATA_DIR` environment variable, resolved to `keiko-ui.db` inside that directory.
3. Default: `homedir()/.keiko/keiko-ui.db` — the user-level app-data directory, **not** a
   workspace directory. The DB must never reside inside a target repository (contrast with
   evidence, which is workspace-relative for co-location reasons — projects/chats are user-global,
   not per-repo).

Explicit `--ui-db` values and `KEIKO_UI_DATA_DIR` must be absolute, must not resolve inside the
current workspace, and must not point at a symlinked database file or symlinked data directory.
The default app-data path remains `~/.keiko/keiko-ui.db`.

### D5 — Schema, PRAGMA user_version, and migration runner

We will use `PRAGMA user_version` as the schema version counter. An ordered migration runner
in `src/ui/store/schema.ts` applies migrations idempotently, checking the current
`user_version` and running only the migrations whose index is >= the current version, then
bumping `user_version` to the new count. Migrations run inside a transaction; a failure rolls
back and surfaces a typed `UiStoreMigrationError`.

**v1 schema (initial):**

```sql
PRAGMA journal_mode = WAL;   -- WAL mode: readers never block writers; safe for single-process

CREATE TABLE projects (
  path          TEXT NOT NULL PRIMARY KEY,   -- normalized absolute path, UNIQUE
  name          TEXT NOT NULL,
  favorite      INTEGER NOT NULL DEFAULT 0,  -- 0 / 1 (SQLite boolean)
  created_at    INTEGER NOT NULL,            -- epoch ms
  last_opened_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chats (
  id             TEXT NOT NULL PRIMARY KEY,  -- UUID v4
  project_path   TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  selected_model TEXT NOT NULL,              -- registry id only
  branch_label   TEXT,
  status         TEXT,                       -- 'open' | 'closed' | NULL
  created_at     INTEGER NOT NULL,           -- epoch ms
  updated_at     INTEGER NOT NULL            -- epoch ms
) STRICT;

CREATE TABLE chat_messages (
  id              TEXT NOT NULL PRIMARY KEY, -- UUID v4
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,             -- 'user' | 'assistant' | 'system'
  content         TEXT NOT NULL,
  timestamp       INTEGER NOT NULL,          -- epoch ms
  -- Lightweight workflow reference (nullable)
  run_id          TEXT,
  workflow_id     TEXT,
  workflow_status TEXT,                      -- 'pending' | 'running' | 'completed' | 'failed' | NULL
  short_result    TEXT                       -- ≤ 200 chars, redacted before persist
) STRICT;

CREATE INDEX idx_chats_project_path   ON chats(project_path);
CREATE INDEX idx_messages_chat_id     ON chat_messages(chat_id);
```

`STRICT` tables enforce column type constraints at the SQLite layer, providing a defense-in-depth
against mismatched inserts without a separate validation library.

**Workflow references are lightweight columns, not a separate table.** Per-message `run_id`,
`workflow_id`, `workflow_status`, and `short_result` columns cover the issue requirement without
duplicating evidence manifests, SSE payloads, or audit data. A separate `workflow_refs` table
would be warranted only if workflow metadata were queried independently of messages (e.g.
listed without message context) or if the columns grew beyond five. Three usages of the current
inline pattern must be observed before extracting it. This is recorded as a documented extension
point.

**WAL mode.** `PRAGMA journal_mode = WAL` is set once at DB open. WAL allows concurrent reads
during a write and is the correct mode for a local single-writer, potentially multi-reader
process (e.g. a future CLI command that reads the DB while `keiko ui` is running). WAL is
applied before the migration runner and after `PRAGMA foreign_keys = ON` and the permission
hardening.

**Availability is derived, not persisted.** A project's directory may be deleted or moved after
it is registered. The store does **not** add an `available` column and does **not** silently
delete projects with missing paths. `listProjects` returns all rows; the BFF handler calls
`fs.existsSync(path)` at read time and includes an `available: boolean` field in the JSON
response, derived from that check. Missing paths remain listed as `available: false`. A developer
can see and explicitly delete a stale project. This preserves the history and makes the system
fail-open (show the record) rather than silently destructive (delete the record).

### D6 — Path validation policy (fail-closed)

All path validation for project paths is centralized in `src/ui/store/validation.ts`. No path
reaches the database without passing every check. The policy is:

1. **Null-byte rejection.** Any path containing `\x00` → `invalid_path` (400).
2. **Absolute POSIX-style path required.** Paths not starting with `/` → `invalid_path` (400).
   Windows drive-letter, UNC, and device-root forms are rejected in V1 rather than normalized
   cross-platform.
3. **No remote URL forms.** Paths matching `/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//` (scheme + `//`)
   → `invalid_path` (400). This rejects `http://`, `file://`, `ssh://`, etc.
4. **No Windows/UNC path forms.** Reject `C:\repo`, `\\server\share\repo`,
   `//server/share/repo`, and backslash traversal segments such as `\..\`.
5. **Normalize and re-check.** `path.normalize(input)` followed by `path.resolve(input)` to
   produce the canonical absolute path; re-verify the result is still absolute.
6. **No trailing traversal residue.** Reject any path containing `/../` or ending in `/..` after
   normalization — defense in depth against edge cases not caught by `path.resolve`.
7. **`stat` as existing directory (CREATE only).** At project create time, the normalized path
   must `fs.statSync` as a directory (`stat.isDirectory() === true`). A regular file → 
   `path_not_directory` (400). A missing path → `path_not_found` (400). After creation,
   availability is computed on read (D5 note on derived availability), not re-validated on every
   mutation.
8. **Length cap.** Paths longer than 4096 characters → `invalid_path` (400).

**Stable error codes (for the `{ error: { code, message } }` envelope):**

| Violation | HTTP status | `code` |
|---|---|---|
| Null byte, non-absolute, remote URL, over-length, traversal residue | 400 | `invalid_path` |
| `stat` returns a non-directory | 400 | `path_not_directory` |
| `stat` throws (path not found) | 400 | `path_not_found` |
| Path already registered (UNIQUE violation on insert) | 409 | `project_exists` |
| Malformed request body | 400 | `invalid_request` |

### D7 — Route contract (additive to ADR-0011 D5)

We will add **ten new routes** to `src/ui/routes.ts`, dispatched from the same `routeRequest`
function that handles the existing twelve routes. They are a new dispatch branch for
`/api/projects` and `/api/chats` alongside the existing `/api/runs`, `/api/evidence`, and
`/api/workspace` branches. All responses use the existing `{ error: { code, message } }` error
envelope and `SECURITY_HEADERS` from `src/ui/headers.ts`. JSON body reading reuses the
`readBody` / `MAX_BODY_BYTES` pattern established in `src/ui/run-handlers.ts`. Every route is
GET/POST/PATCH/DELETE via HTTP method; resources are addressed by **query parameters** (not path
parameters for mutable entities), preserving static-export compatibility per ADR-0011 D1.

**New routes (numbered 13–22, additive to the D5 contract):**

| # | Method | Path | Query params | Notes |
|---|---|---|---|---|
| 13 | `GET` | `/api/projects` | — | Returns `{ projects: (Project & { available: boolean })[] }`, availability derived from `fs.existsSync` at read time. |
| 14 | `POST` | `/api/projects` | — | Body: `{ path: string, name?: string }`. Validates path (D6). Returns `201 { project: Project & { available: boolean } }`. |
| 15 | `PATCH` | `/api/projects` | `?path=...` | Body: `{ name?: string, favorite?: boolean }`. Returns `{ project: Project & { available: boolean } }`. 404 if unknown. |
| 16 | `DELETE` | `/api/projects` | `?path=...` | Cascades to chats + messages via `ON DELETE CASCADE`. Returns `204`. 404 if unknown. |
| 17 | `GET` | `/api/chats` | `?projectPath=...` | Returns `{ chats: Chat[] }` for the given project. 400 if `projectPath` is missing. |
| 18 | `POST` | `/api/chats` | — | Body: `{ projectPath: string, title: string, selectedModel: string, branchLabel?: string }`. `selectedModel` must be an existing capability registry id with `kind === "chat"`. Returns `201 { chat: Chat }`. 404 if project unknown. |
| 19 | `PATCH` | `/api/chats` | `?id=...` | Body: `{ title?: string, selectedModel?: string, branchLabel?: string, status?: string }`. If present, `selectedModel` must be an existing capability registry id with `kind === "chat"`. Returns `{ chat: Chat }`. 404 if unknown. |
| 20 | `DELETE` | `/api/chats` | `?id=...` | Cascades to messages. Returns `204`. 404 if unknown. |
| 21 | `GET` | `/api/chats/messages` | `?chatId=...` | Returns `{ messages: ChatMessage[] }`. 400 if `chatId` missing. |
| 22 | `POST` | `/api/chats/messages` | — | Body: `{ chatId, role, content, timestamp, runId?, workflowId?, workflowStatus?, shortResult? }`. Returns `201 { message: ChatMessage }`. `shortResult` truncated to 200 chars + redacted before persist. |

`PATCH /api/projects` does not accept client-supplied timestamps. The implementation bumps
`last_opened_at` to `Date.now()` server-side for every accepted patch, mirroring the "touch on
open" pattern expected by the issue without trusting the browser clock.

**Static-export compatibility.** All ten new routes use fixed path strings and query
parameters — no `:param` path segments on mutable resources. The route matcher in
`src/ui/routes.ts` can match them exactly, just as it matches the existing twelve routes.

### D8 — Security posture

**Parameterized statements only.** Every SQL statement in `src/ui/store/**` uses a
`StatementSync` prepared statement with `?` or named (`@name`) placeholders. No string
interpolation into SQL text. This is enforced structurally: all SQL text is a constant defined at
module scope; no function receives a SQL fragment as a parameter. This is the primary SQL
injection defense.

**Restrictive file permissions.** `src/ui/store/db.ts` applies `fs.chmodSync(dbPath, 0o600)` and
`fs.chmodSync(dirPath, 0o700)` (owner read/write only) after creating the DB file. This mirrors
ADR-0010's posture for the evidence directory and is consistent with SQLite WAL mode (which
creates `-wal` and `-shm` sidecar files in the same directory; those sidecars inherit the
directory's permissions at creation time on most OS configurations, but `db.ts` also chmods them
when present). Permissions are applied after `openDatabase` and before any migration, so the file
is never world-readable.

**No secrets or provider details persisted.** `selectedModel` stores the registry id only (e.g.
`"Mistral-Small-3.1-24B-Instruct-2503"`) — never an API key, provider URL, deployment mapping,
or authentication credential. The BFF accepts only capability registry entries with
`kind === "chat"`; the store layer also rejects URL-, JSON-, and secret-shaped values before they
can be written. The `short_result` column (chat messages) is passed through
`deepRedactStrings(value, redactor)` before persistence, using the same `UiHandlerDeps.redactor`
the BFF already applies to live payloads (ADR-0011 D9). No reasoning traces, no evidence
payloads, no SSE event data are stored in the DB.

**DB location never inside a target repository.** The default path is
`homedir()/.keiko/keiko-ui.db`. The `KEIKO_UI_DATA_DIR` env var and the `--ui-db` option allow
relocation (for tests: an OS-temp `mkdtemp` path) only to absolute, non-workspace, non-symlink
locations. The BFF enforces the app-data boundary by construction: `resolveUiDbPath` is called
once at server start, not per-request, so the DB path is stable and does not interact with
project path validation. Adding `~/.keiko/` to `.gitignore` is unnecessary (it is outside any
repository) but `~/.keiko/` is documented in the runbook as the app-data directory.

**Reuse-unchanged invariant.** Zero edits to `src/{gateway,harness,workspace,tools,
verification,workflows,audit}`. The existing twelve routes (ADR-0011 D5) are not modified; they
are regression-non-regressing by construction because they are wired independently.

### D9 — Concurrency model and WAL mode

`node:sqlite`'s `DatabaseSync` is **synchronous and single-threaded** — operations block the
event loop. The BFF is a single-process, single-thread Node server; there is no worker-thread or
child-process concurrency for the store. This is an honest constraint of `node:sqlite`'s design
in Node 22.x, and it is acceptable for a local developer UI: store operations (project list, chat
upsert) are fast (microseconds) and infrequent relative to the SSE/run lifecycle.

WAL mode (`PRAGMA journal_mode = WAL`) is set at DB open. WAL allows a reader to proceed
concurrently with a single writer at the SQLite level; in practice, for this single-process
server, WAL's primary benefit is that a crash or signal mid-write leaves the DB in a clean state
(WAL frames are rolled back or replayed on the next open), not a torn journal. The WAL sidecar
files (`keiko-ui.db-wal`, `keiko-ui.db-shm`) are part of the normal operation and are documented
in the runbook.

`DatabaseSync`'s blocking behaviour means the store must not be called from within an SSE event
callback or any hot path that could starve the event loop for meaningful durations. Route handlers
call the store synchronously and return immediately; this is the only call site pattern permitted.
Long-running store operations (bulk insert, vacuum) are out of scope.

### D10 — Scope fence

**In scope.** The `src/ui/store/**` module; `UiStore` port and `createNodeUiStore` adapter;
`createInMemoryUiStore` for tests; `UiHandlerDeps` wiring; nine new routes (D7); path validation
(D6); schema v1 and migration runner; DB permission hardening; `vitest.config.ts` flag addition
(D2 site 2); re-exec guard in `src/cli/ui.ts` (D2 site 1); frontend client stubs in `ui/lib/`
for the nine new routes; unit and integration tests under `tests/ui/store/**`.

**Out of scope.** Multi-user / RBAC / shared-DB; remote/hosted persistence; cross-device sync;
full-text search over message content; DB encryption at rest; storing evidence manifests or SSE
event payloads; the async-iterable `EventSink` upgrade (ADR-0011 D7); any edit to the frozen
core layers.

**Workflow-ref table extraction.** The four workflow reference columns on `chat_messages` are
inline (D5). Extracting them to a separate `workflow_refs` table is a documented extension point,
not Wave-2 scope. The criterion is: if workflow metadata is queried independently of messages
(e.g. a dedicated "run history" view), a separate table becomes the correct shape — add that as a
migration (`user_version` 2) under a follow-up issue.

## Consequences

### Positive

- **Zero new runtime dependencies.** `node:sqlite` is a built-in; `dependencies: {}` is
  unchanged. All seven required CI checks stay lean and green with no new audit surface, no SBOM
  expansion, and no license-review risk (ADR-0001, ADR-0002).
- **No native-addon compile risk.** `better-sqlite3` requires `node-gyp`; `node:sqlite` does not.
  Regulated-pilot installs on locked-down machines or CI environments without a C++ toolchain
  work without modification.
- **Real SQLite semantics.** ACID transactions, foreign-key cascades, `STRICT` table typing, WAL
  mode, and prepared statements — not a hand-rolled file format.
- **Injected DB path and in-memory store.** Tests inject a `mkdtemp` path or a
  `createInMemoryUiStore`, never touching the real `~/.keiko/` directory. The `UiStore` port
  mirrors the `EvidenceStore` pattern the team already knows.
- **Additive route contract.** Nine new routes at new paths; no existing route is modified;
  static-export compatibility is preserved by query-parameter addressing.
- **Availability is derived, not persisted.** Projects are never silently deleted; a stale entry
  is surfaced as `available: false`, preserving history and avoiding accidental data loss.
- **Fail-closed path validation.** Seven rules in one `validate.ts` function; no path reaches the
  DB without passing all of them.

### Negative

- **`node:sqlite` is experimental in Node 22.x.** API stability is not guaranteed across 22.x
  patch releases (though in practice the `DatabaseSync` / `StatementSync` surface has been stable
  since its introduction). Upgrading from Node 22 to 24 removes the experimental status entirely;
  Node 24 is the long-term resolution.
- **Re-exec guard complexity.** The guard in `src/cli/ui.ts` adds a code path that spawns a
  child process on early Node 22.x builds. It is tested independently, but it is non-trivial and
  must be maintained until the `engines` pin advances past 22.11.
- **Blocking event loop on store operations.** `DatabaseSync` is synchronous. While operations
  are fast and infrequent, any future bulk-write requirement would require a worker-thread
  migration. This is documented as a known constraint.
- **WAL sidecar files.** WAL mode creates `keiko-ui.db-wal` and `keiko-ui.db-shm` alongside
  `keiko-ui.db`. These are normal and safe but may surprise developers who inspect `~/.keiko/`
  directly.
- **Single-process, local-only persistence.** The DB cannot be shared across machines or users.
  This is a stated scope boundary for the local developer UI, not a bug.

### Neutral

- `homedir()/.keiko/keiko-ui.db` is the default DB path; `~/.keiko/` is outside any repository and
  does not need a `.gitignore` entry (contrast with `.keiko/evidence/` which IS inside the repo).
- A test-injected `KEIKO_UI_DATA_DIR` env var mirrors the data-directory precedence pattern used
  by other local Keiko stores.
- `STRICT` tables catch type mismatches at the SQLite level; no separate schema-validation
  library is needed.
- Cascade deletes (`ON DELETE CASCADE`) mean `deleteProject` removes all chats and messages for
  that project in one SQL operation without BFF-layer loop logic.

## Alternatives Considered

### Alternative 1: `better-sqlite3` (npm runtime dependency)

The most widely used Node SQLite wrapper. Synchronous API, well-documented, widely deployed.

- **Pros**: stable, production-grade, widely used; full SQLite feature set; no experimental
  status; excellent TypeScript types.
- **Cons**: it is a **runtime dependency** with a native addon (`node-gyp`, C++ build). Adding it
  to `dependencies` expands `npm audit --audit-level=high`, `npm sbom --omit dev`, and
  `dependency-review` — directly threatening the `Build, scan, SBOM, smoke` required check and
  the regulated-pilot supply-chain posture. A native addon also introduces compile-time risk on
  locked-down environments. Version churn introduces recurring CVE review obligations.
- **Why rejected**: violates the load-bearing zero-new-runtime-dependency invariant (ADR-0001,
  ADR-0011 D1). The supply-chain gate expansion is the decisive rejection reason; `node:sqlite`
  provides an equivalent synchronous API from the built-in without any of these costs.

### Alternative 2: `sql.js` (WASM-based SQLite)

`sql.js` ships a WASM build of SQLite that runs entirely in Node without native compilation.

- **Pros**: no native addon; deterministic WASM binary; well-tested SQLite semantics; the entire
  SQLite library is bundled in the WASM file, so the API surface is stable.
- **Cons**: it is still a **runtime dependency** (the WASM binary ships in the package); `npm
  audit`, `npm sbom --omit dev`, and `dependency-review` still see it. Persistence requires
  explicit manual export of the in-memory database to disk on every write and load on every open —
  awkward, non-atomic, and a source of data-loss risk. WASM execution adds startup latency on
  every `keiko ui` invocation.
- **Why rejected**: still a runtime dependency; the manual persist-on-write model is fragile
  compared to real SQLite file I/O; `node:sqlite` provides the same semantics with zero
  dependency and atomic WAL-mode writes.

### Alternative 3: Hand-rolled JSON / NDJSON file store

Store projects and chats as JSON files in `~/.keiko/ui/`, mirroring the evidence manifest
pattern (`src/audit/store.ts`).

- **Pros**: zero new dependency; no SQLite; directly inspectable by developers; trivially
  portable; mirrors an established pattern in the codebase.
- **Cons**: no real relational integrity — cascading deletes, FK constraints, and atomic
  multi-row updates require manual bookkeeping; concurrent-read safety requires file locking;
  queries (list chats for project, filter by date) require loading and filtering all records in
  memory; chat message history could grow to thousands of entries per chat, making full-file loads
  slow and wasteful; schema evolution requires bespoke migration code more fragile than
  `PRAGMA user_version` + SQL migrations.
- **Why rejected**: the issue requires a "SQLite-backed store" (explicit in the issue title).
  Beyond compliance with the issue, the relational query and cascade requirements of
  projects-with-chats-with-messages justify a real relational store. The evidence manifest
  pattern is the right shape for immutable, append-only audit records — not for mutable,
  relational chat history.

### Alternative 4: IndexedDB in the browser (no BFF persistence)

Store projects and chats in browser `IndexedDB` (or `localStorage`) rather than the Node BFF.

- **Pros**: no server-side storage; no DB file; no migration runner; well-supported browser API.
- **Cons**: directly violates the trust boundary (ADR-0011 D2): the browser is the untrusted
  presentation tier and holds no filesystem authority. A project's `path` is a server-side
  absolute filesystem path — persisting it in the browser means the browser learns real
  filesystem paths, which is a capability the design explicitly forbids. Browser storage is also
  per-origin and opaque to the CLI; `keiko evidence list` and future CLI commands that reference
  projects would have no access to browser storage. Data would be lost on private-browsing
  sessions or browser data clears.
- **Why rejected**: the boundary (server = authority, browser = presentation) is the
  foundational design principle of ADR-0011 D2. Persisting server-side filesystem paths in the
  browser violates it structurally. The BFF must own all stateful persistence.

### Alternative 5: SQLite via a separate microservice or worker thread

Run a SQLite store in a dedicated worker thread (via `worker_threads`) or a separate `sqlite3`
process so that DB operations do not block the main event loop.

- **Pros**: non-blocking event loop even for slow queries; cleaner async BFF handler code.
- **Cons**: significantly more complex: a worker thread needs a message-passing protocol and
  serialization layer; a separate process needs IPC; both add failure modes (worker crash,
  process death) with no recovery path specified; neither is needed for the actual workload
  (project list, chat upsert — microsecond operations on a local SSD). The `node:sqlite`
  documentation explicitly models `DatabaseSync` for synchronous single-threaded use.
- **Why rejected**: YAGNI. The workload does not justify the complexity. `DatabaseSync` is the
  correct synchronous API for a single-process BFF with infrequent, fast store operations. If a
  future requirement demands non-blocking SQLite (e.g. full-text search over thousands of
  messages), a worker-thread migration is a well-contained follow-up bounded by the `UiStore`
  port (the handler layer does not change).

## Related

- ADR-0001: Project Foundation and Toolchain — zero-runtime-dependency constraint (load-bearing);
  `src/ui/store/` module location within `src/ui/**`; strict TypeScript/ESM/LOC limits apply.
- ADR-0002: CI and Supply-Chain Security Baseline — seven byte-exact required checks whose green
  status this ADR preserves; `node:sqlite` as a built-in is invisible to `npm audit`, `npm sbom`,
  and `dependency-review`; `vitest.config.ts` `execArgv` addition is the only CI-touching change
  (it does not rename any job or step).
- ADR-0010: Audit Ledger and Evidence Manifests — `EvidenceStore` port pattern mirrored by
  `UiStore`; `resolveEvidenceDir` pattern mirrored by `resolveUiDbPath`; `createAuditRedactor` /
  `deepRedactStrings` reused for `short_result` redaction before persist; DB path is
  `~/.keiko/keiko-ui.db` (user-level, not workspace-relative, contrast with evidence's
  `.keiko/evidence/`).
- ADR-0011: Wave-1 User Interface and Packaging — `UiHandlerDeps` injection pattern extended;
  `SECURITY_HEADERS` + error envelope reused; static-export constraint governs query-parameter
  route addressing (D1); `readBody`/`MAX_BODY_BYTES` pattern reused; zero-runtime-dependency
  invariant (D1) is the decisive selection factor for `node:sqlite`; reuse-unchanged invariant
  (D2) applies identically.
- Issue #62: Add UI-local SQLite persistence for projects and chats.
- Issue #61: Parent epic.
- Node.js `node:sqlite` documentation: https://nodejs.org/docs/latest-v22.x/api/sqlite.html
- Node.js v22 release notes (SQLite built-in introduction): Node 22.5.0.

## Date

2026-05-30
