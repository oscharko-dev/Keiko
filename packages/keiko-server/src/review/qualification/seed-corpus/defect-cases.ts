// The nine planted-defect cases of the synthetic review seed corpus (Issue #4132). Each is a small
// generated repository — an invoice service, a sync client, a file share — written for this corpus
// alone: no Keiko or customer code. One change per case plants exactly one defect; the rest of the
// tree is context a reviewer may read but that holds nothing to find.

import { defectCase, type ReviewSeedCorpusEntry } from "./define.js";

const HTTP_TYPES = `export interface User {
  readonly id: string;
  readonly roles: readonly string[];
}

export interface Request {
  readonly user: User | undefined;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | undefined>>;
}

export interface Response {
  status(code: number): Response;
  send(body: string): void;
}
`;

const AUTH = `import type { User } from "./http.js";

export function hasRole(user: User | undefined, role: string): boolean {
  return user !== undefined && user.roles.includes(role);
}
`;

const DELETE_ROUTE_BASE = `import { hasRole } from "./auth.js";
import type { Request, Response } from "./http.js";
import { deleteInvoice } from "./store.js";

export async function handleDeleteInvoice(req: Request, res: Response): Promise<void> {
  if (!hasRole(req.user, "billing-admin")) {
    res.status(403).send("forbidden");
    return;
  }
  await deleteInvoice(req.params.id ?? "");
  res.status(204).send("");
}
`;

const DELETE_ROUTE_HEAD = `import type { Request, Response } from "./http.js";
import { deleteInvoice } from "./store.js";

export async function handleDeleteInvoice(req: Request, res: Response): Promise<void> {
  await deleteInvoice(req.params.id ?? "");
  res.status(204).send("");
}
`;

const STORE = `const invoices = new Map<string, { readonly total: number }>();

export async function deleteInvoice(id: string): Promise<void> {
  await Promise.resolve();
  invoices.delete(id);
}
`;

const removedAuthorizationGuard = defectCase({
  id: "synthetic-removed-authorization-guard",
  kind: "removed-authorization-guard",
  seedClass: "security",
  file: "src/routes.ts",
  planted:
    "export async function handleDeleteInvoice(req: Request, res: Response): Promise<void> {\n" +
    '  await deleteInvoice(req.params.id ?? "");\n',
  baseFiles: {
    "src/http.ts": HTTP_TYPES,
    "src/auth.ts": AUTH,
    "src/store.ts": STORE,
    "src/routes.ts": DELETE_ROUTE_BASE,
  },
  headFiles: {
    "src/http.ts": HTTP_TYPES,
    "src/auth.ts": AUTH,
    "src/store.ts": STORE,
    "src/routes.ts": DELETE_ROUTE_HEAD,
  },
  summary: "The billing-admin role check before deleting an invoice is removed.",
});

const UPLOAD_BASE = `export class SyncError extends Error {}

export async function pushChanges(
  upload: (batch: readonly string[]) => Promise<void>,
  batch: readonly string[],
): Promise<void> {
  try {
    await upload(batch);
  } catch (error) {
    throw new SyncError("upload failed", { cause: error });
  }
}
`;

const UPLOAD_HEAD = `export class SyncError extends Error {}

export async function pushChanges(
  upload: (batch: readonly string[]) => Promise<void>,
  batch: readonly string[],
): Promise<void> {
  try {
    await upload(batch);
  } catch {
    // A failed upload is retried by the next scheduled sync.
  }
}
`;

const swallowedError = defectCase({
  id: "synthetic-swallowed-error",
  kind: "swallowed-error",
  seedClass: "reliability",
  file: "src/sync.ts",
  planted: "  } catch {\n    // A failed upload is retried by the next scheduled sync.\n  }\n",
  baseFiles: { "src/sync.ts": UPLOAD_BASE },
  headFiles: { "src/sync.ts": UPLOAD_HEAD },
  summary: "An upload failure is caught and dropped; callers report a sync that never happened.",
});

const AUDIT_BASE = `export interface AuditEntry {
  readonly actor: string;
  readonly action: string;
}

export async function recordTransfer(
  writeAudit: (entry: AuditEntry) => Promise<void>,
  transfer: () => Promise<string>,
  actor: string,
): Promise<string> {
  await writeAudit({ actor, action: "transfer" });
  return transfer();
}
`;

const missingAwait = defectCase({
  id: "synthetic-missing-await",
  kind: "missing-await",
  seedClass: "concurrency",
  file: "src/audit.ts",
  planted: '  void writeAudit({ actor, action: "transfer" });\n',
  baseFiles: { "src/audit.ts": AUDIT_BASE },
  headFiles: {
    "src/audit.ts": AUDIT_BASE.replace(
      '  await writeAudit({ actor, action: "transfer" });\n',
      '  void writeAudit({ actor, action: "transfer" });\n',
    ),
  },
  summary: "The audit write is no longer awaited, so a transfer runs even when auditing fails.",
});

const PAGE_BASE = `export function pageOf<T>(items: readonly T[], page: number, size: number): readonly T[] {
  const result: T[] = [];
  const start = page * size;
  for (let index = start; index < Math.min(start + size, items.length); index += 1) {
    const item = items[index];
    if (item !== undefined) result.push(item);
  }
  return result;
}
`;

const offByOne = defectCase({
  id: "synthetic-off-by-one-boundary",
  kind: "off-by-one-boundary",
  seedClass: "correctness",
  file: "src/paging.ts",
  planted:
    "  for (let index = start; index <= Math.min(start + size, items.length); index += 1) {\n",
  baseFiles: { "src/paging.ts": PAGE_BASE },
  headFiles: {
    "src/paging.ts": PAGE_BASE.replace("index < Math.min(", "index <= Math.min("),
  },
  summary: "The page loop runs one index past its end and leaks the first item of the next page.",
});

const PROFILE_BASE = `export interface Profile {
  readonly displayName: string;
}

export interface Account {
  readonly profile?: Profile;
}

export function greeting(account: Account | undefined): string {
  const name = account?.profile?.displayName ?? "guest";
  return \`Hello, \${name.trim()}\`;
}
`;

const nullishDereference = defectCase({
  id: "synthetic-nullish-dereference-after-optional",
  kind: "nullish-dereference-after-optional",
  seedClass: "correctness",
  file: "src/greeting.ts",
  planted: "  const name = (account?.profile as Profile).displayName;\n",
  baseFiles: { "src/greeting.ts": PROFILE_BASE },
  headFiles: {
    "src/greeting.ts": PROFILE_BASE.replace(
      '  const name = account?.profile?.displayName ?? "guest";\n',
      "  const name = (account?.profile as Profile).displayName;\n",
    ),
  },
  summary: "An optional profile is cast away and dereferenced; a guest account now throws.",
});

const SHARE_BASE = `import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

export async function readShared(root: string, requested: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, requested);
  if (!target.startsWith(absoluteRoot + sep)) {
    throw new Error("requested file is outside the share");
  }
  return readFile(target, "utf8");
}
`;

const SHARE_HEAD = `import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readShared(root: string, requested: string): Promise<string> {
  return readFile(join(root, requested), "utf8");
}
`;

const pathTraversal = defectCase({
  id: "synthetic-path-traversal-in-file-read",
  kind: "path-traversal-in-file-read",
  seedClass: "security",
  file: "src/share.ts",
  planted: '  return readFile(join(root, requested), "utf8");\n',
  baseFiles: { "src/share.ts": SHARE_BASE },
  headFiles: { "src/share.ts": SHARE_HEAD },
  summary: "A requested name is joined to the share root unchecked, so `../` reads any file.",
});

const LOG_BASE = `import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function branchLog(branch: string): Promise<string> {
  const { stdout } = await run("git", ["log", "--oneline", "--", branch]);
  return stdout;
}
`;

const LOG_HEAD = `import { exec } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(exec);

export async function branchLog(branch: string): Promise<string> {
  const { stdout } = await run(\`git log --oneline \${branch}\`);
  return stdout;
}
`;

const ROUTE_LOG = `import type { Request, Response } from "./http.js";
import { branchLog } from "./git.js";

export async function handleLog(req: Request, res: Response): Promise<void> {
  res.status(200).send(await branchLog(req.query.branch ?? "main"));
}
`;

const uncheckedInput = defectCase({
  id: "synthetic-unchecked-input-to-sensitive-sink",
  kind: "unchecked-input-to-sensitive-sink",
  seedClass: "security",
  file: "src/git.ts",
  planted: "  const { stdout } = await run(`git log --oneline ${branch}`);\n",
  baseFiles: { "src/http.ts": HTTP_TYPES, "src/log-route.ts": ROUTE_LOG, "src/git.ts": LOG_BASE },
  headFiles: { "src/http.ts": HTTP_TYPES, "src/log-route.ts": ROUTE_LOG, "src/git.ts": LOG_HEAD },
  summary: "A query-string branch name reaches a shell command line unescaped.",
});

const CONFIG_BASE = `import { open } from "node:fs/promises";

export async function loadSettings(path: string): Promise<Record<string, unknown>> {
  const handle = await open(path, "r");
  try {
    return JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}
`;

const CONFIG_HEAD = `import { open } from "node:fs/promises";

export async function loadSettings(path: string): Promise<Record<string, unknown>> {
  const handle = await open(path, "r");
  const settings = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
  await handle.close();
  return settings;
}
`;

const resourceLeak = defectCase({
  id: "synthetic-resource-not-released-on-error-path",
  kind: "resource-not-released-on-error-path",
  seedClass: "reliability",
  file: "src/settings.ts",
  planted:
    '  const settings = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;\n' +
    "  await handle.close();\n",
  baseFiles: { "src/settings.ts": CONFIG_BASE },
  headFiles: { "src/settings.ts": CONFIG_HEAD },
  summary: "A malformed settings file throws before `close`, leaking the file handle.",
});

const TOKEN_BASE = `export interface SessionToken {
  readonly subject: string;
  readonly expiresAt: number;
}

export function assertUsable(token: SessionToken, nowMs: number): void {
  if (token.expiresAt <= nowMs) {
    throw new Error("session token has expired");
  }
}
`;

const invertedCondition = defectCase({
  id: "synthetic-inverted-condition",
  kind: "inverted-condition",
  seedClass: "correctness",
  file: "src/session.ts",
  planted: "  if (token.expiresAt > nowMs) {\n",
  baseFiles: { "src/session.ts": TOKEN_BASE },
  headFiles: {
    "src/session.ts": TOKEN_BASE.replace(
      "  if (token.expiresAt <= nowMs) {\n",
      "  if (token.expiresAt > nowMs) {\n",
    ),
  },
  summary: "The expiry check is inverted: live tokens are rejected and expired ones accepted.",
});

export const REVIEW_SEED_DEFECT_CASES: readonly ReviewSeedCorpusEntry[] = Object.freeze([
  removedAuthorizationGuard,
  swallowedError,
  missingAwait,
  offByOne,
  nullishDereference,
  pathTraversal,
  uncheckedInput,
  resourceLeak,
  invertedCondition,
]);
