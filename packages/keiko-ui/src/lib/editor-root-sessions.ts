import type {
  WorkspaceManifest,
  WorkspaceRootDescriptor,
  WorkspaceRootRef,
} from "@oscharko-dev/keiko-contracts";

export const EDITOR_ROOT_SESSIONS_SCHEMA_VERSION = 1 as const;
export const MAX_EDITOR_ROOT_SESSIONS_JSON_LENGTH = 128_000;
const MAX_EDITOR_ROOT_LAYOUT_JSON_LENGTH = 48_000;

export interface EditorRootSession {
  readonly rootRef: WorkspaceRootRef;
  readonly root: string;
  readonly layoutJson: string;
}

interface EditorRootSessionsEnvelope {
  readonly schemaVersion: typeof EDITOR_ROOT_SESSIONS_SCHEMA_VERSION;
  readonly sessions: readonly EditorRootSession[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function currentRoot(
  manifest: WorkspaceManifest,
  rootRef: unknown,
  rootPath: unknown,
): WorkspaceRootDescriptor | undefined {
  if (typeof rootRef !== "string" || typeof rootPath !== "string") return undefined;
  return manifest.roots.find((root) => root.rootRef === rootRef && root.canonicalRoot === rootPath);
}

function parseSession(
  value: unknown,
  manifest: WorkspaceManifest,
): EditorRootSession | null | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["rootRef", "root", "layoutJson"]) ||
    typeof value["layoutJson"] !== "string" ||
    value["layoutJson"].length === 0 ||
    value["layoutJson"].length > MAX_EDITOR_ROOT_LAYOUT_JSON_LENGTH
  ) {
    return null;
  }
  const current = manifest.roots.find((root) => root.rootRef === value["rootRef"]);
  if (current === undefined) return undefined;
  const root = currentRoot(manifest, value["rootRef"], value["root"]);
  if (root === undefined) return null;
  return { rootRef: root.rootRef, root: root.canonicalRoot, layoutJson: value["layoutJson"] };
}

export function parseEditorRootSessions(
  value: unknown,
  manifest: WorkspaceManifest,
): ReadonlyMap<WorkspaceRootRef, EditorRootSession> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EDITOR_ROOT_SESSIONS_JSON_LENGTH
  ) {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Map();
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["schemaVersion", "sessions"]) ||
    parsed["schemaVersion"] !== EDITOR_ROOT_SESSIONS_SCHEMA_VERSION ||
    !Array.isArray(parsed["sessions"]) ||
    parsed["sessions"].length > 32
  ) {
    return new Map();
  }
  const sessions = new Map<WorkspaceRootRef, EditorRootSession>();
  for (const value of parsed["sessions"]) {
    const session = parseSession(value, manifest);
    if (session === undefined) continue;
    if (session === null || sessions.has(session.rootRef)) return new Map();
    sessions.set(session.rootRef, session);
  }
  return sessions;
}

function orderedRoots(
  manifest: WorkspaceManifest,
  activeRootRef: WorkspaceRootRef,
): readonly WorkspaceRootDescriptor[] {
  const active = manifest.roots.find((root) => root.rootRef === activeRootRef);
  return active === undefined
    ? manifest.roots
    : [active, ...manifest.roots.filter((root) => root.rootRef !== activeRootRef)];
}

export function serializeEditorRootSessions(
  sessions: ReadonlyMap<WorkspaceRootRef, EditorRootSession>,
  manifest: WorkspaceManifest,
  activeRootRef: WorkspaceRootRef,
): string {
  const retained: EditorRootSession[] = [];
  for (const root of orderedRoots(manifest, activeRootRef)) {
    const session = sessions.get(root.rootRef);
    if (session === undefined || session.root !== root.canonicalRoot) continue;
    const candidate: EditorRootSessionsEnvelope = {
      schemaVersion: EDITOR_ROOT_SESSIONS_SCHEMA_VERSION,
      sessions: [...retained, session],
    };
    if (JSON.stringify(candidate).length > MAX_EDITOR_ROOT_SESSIONS_JSON_LENGTH) continue;
    retained.push(session);
  }
  return JSON.stringify({
    schemaVersion: EDITOR_ROOT_SESSIONS_SCHEMA_VERSION,
    sessions: retained,
  } satisfies EditorRootSessionsEnvelope);
}

export function sanitizeEditorRootSessionsJson(
  value: unknown,
  sanitizeLayout: (layoutJson: unknown) => string | undefined = (layoutJson) =>
    typeof layoutJson === "string" ? layoutJson : undefined,
): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EDITOR_ROOT_SESSIONS_JSON_LENGTH
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    !hasOnlyKeys(parsed, ["schemaVersion", "sessions"]) ||
    parsed["schemaVersion"] !== EDITOR_ROOT_SESSIONS_SCHEMA_VERSION ||
    !Array.isArray(parsed["sessions"]) ||
    parsed["sessions"].length > 32
  ) {
    return undefined;
  }
  const sessions: Record<string, string>[] = [];
  const rootRefs = new Set<string>();
  for (const session of parsed["sessions"]) {
    if (
      !isRecord(session) ||
      !hasOnlyKeys(session, ["rootRef", "root", "layoutJson"]) ||
      typeof session["rootRef"] !== "string" ||
      session["rootRef"].length === 0 ||
      session["rootRef"].length > 256 ||
      rootRefs.has(session["rootRef"]) ||
      typeof session["root"] !== "string" ||
      session["root"].length === 0 ||
      session["root"].length > 512 ||
      typeof session["layoutJson"] !== "string" ||
      session["layoutJson"].length === 0 ||
      session["layoutJson"].length > MAX_EDITOR_ROOT_LAYOUT_JSON_LENGTH
    ) {
      return undefined;
    }
    const layoutJson = sanitizeLayout(session["layoutJson"]);
    if (layoutJson === undefined) return undefined;
    rootRefs.add(session["rootRef"]);
    sessions.push({
      rootRef: session["rootRef"],
      root: session["root"],
      layoutJson,
    });
  }
  return JSON.stringify({
    schemaVersion: EDITOR_ROOT_SESSIONS_SCHEMA_VERSION,
    sessions,
  });
}
