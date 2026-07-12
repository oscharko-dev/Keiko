import type { FeedbackPublicationTargetPolicySnapshotV1 } from "@oscharko-dev/keiko-contracts/feedback-publication";
import {
  FEEDBACK_GITHUB_API_ORIGIN_V1,
  isFeedbackPublicationTargetPolicySnapshotV1,
} from "@oscharko-dev/keiko-contracts/feedback-publication";
import { isAbsolute } from "node:path";
import { digestFeedbackTargetPolicyV1 } from "./feedback-publication-projection.js";
import { validateGithubAppPrivateKeyFile } from "./github-app-key.js";
import { readSecureOperatorFile } from "./github-secure-file.js";

const APP_ID = /^[1-9][0-9]{0,19}$/u;
const RFC3339_TIMESTAMP =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/u;
const MAX_TARGET_FILE_BYTES = 64 * 1024;
const MAX_TARGETS = 64;
const ROOT_KEYS = ["targets", "version"] as const;
const TARGET_KEYS = [
  "installationId",
  "labelPolicyVersion",
  "labels",
  "owner",
  "repository",
  "repositoryId",
  "targetKey",
  "targetPolicyVersion",
] as const;

export interface GithubAppOperatorInput {
  readonly appId?: string;
  readonly privateKeyFile?: string;
  readonly targetsPolicyFile?: string;
  readonly privateKeyRotatedAt?: string;
}

export type GithubAppConfigReadiness =
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly reason: "configuration-invalid" }
  | { readonly status: "ready"; readonly config: GithubAppConfig };

export interface GithubAppTarget {
  readonly snapshot: FeedbackPublicationTargetPolicySnapshotV1;
  readonly digest: string;
}

export interface GithubAppConfig {
  readonly apiOrigin: typeof FEEDBACK_GITHUB_API_ORIGIN_V1;
  readonly appId: string;
  readonly privateKeyFile: string;
  readonly privateKeyRotatedAt: string;
  readonly targets: ReadonlyMap<string, GithubAppTarget>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function parseRfc3339Timestamp(value: string): Date | undefined {
  const match = RFC3339_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const [yearValue, monthValue, dayValue] = match.slice(1, 4);
  if (yearValue === undefined || monthValue === undefined || dayValue === undefined)
    return undefined;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  if (maximumDay === undefined || day > maximumDay) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : undefined;
}

// The bounded scanner deliberately counts each JSON structural branch.
// eslint-disable-next-line complexity
function hasDuplicateKeys(source: string): boolean {
  const scopes: Set<string>[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") scopes.push(new Set());
    else if (character === "}") scopes.pop();
    else if (character === '"' && scopes.length > 0) {
      let end = index + 1;
      for (; end < source.length; end += 1) {
        if (source[end] === "\\") end += 1;
        else if (source[end] === '"') break;
      }
      let cursor = end + 1;
      while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] === ":") {
        const key = JSON.parse(source.slice(index, end + 1)) as string;
        const scope = scopes.at(-1);
        if (scope?.has(key) === true) return true;
        scope?.add(key);
      }
      index = end;
    }
  }
  return false;
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (hasDuplicateKeys(source)) throw new Error("duplicate");
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("GitHub App target policy is invalid");
  }
}

function targetSnapshot(value: unknown): FeedbackPublicationTargetPolicySnapshotV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub App target policy is invalid");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, TARGET_KEYS)) throw new Error("GitHub App target policy is invalid");
  const snapshot = { ...record, apiOrigin: FEEDBACK_GITHUB_API_ORIGIN_V1 };
  if (!isFeedbackPublicationTargetPolicySnapshotV1(snapshot)) {
    throw new Error("GitHub App target policy is invalid");
  }
  return Object.freeze({ ...snapshot, labels: Object.freeze([...snapshot.labels]) });
}

function immutableTargets(
  source: ReadonlyMap<string, GithubAppTarget>,
): ReadonlyMap<string, GithubAppTarget> {
  const facade: ReadonlyMap<string, GithubAppTarget> = {
    get size(): number {
      return source.size;
    },
    get: (key: string): GithubAppTarget | undefined => source.get(key),
    has: (key: string): boolean => source.has(key),
    entries: (): MapIterator<[string, GithubAppTarget]> => source.entries(),
    keys: (): MapIterator<string> => source.keys(),
    values: (): MapIterator<GithubAppTarget> => source.values(),
    forEach: (
      callback: (
        value: GithubAppTarget,
        key: string,
        map: ReadonlyMap<string, GithubAppTarget>,
      ) => void,
      thisArg?: unknown,
    ): void => {
      source.forEach((value, key) => {
        callback.call(thisArg, value, key, facade);
      });
    },
    [Symbol.iterator]: (): MapIterator<[string, GithubAppTarget]> => source.entries(),
  };
  return Object.freeze(facade);
}

// Validation is intentionally one fail-closed pass over the bounded file.
// eslint-disable-next-line complexity
function loadTargets(path: string): ReadonlyMap<string, GithubAppTarget> {
  const value = decodeJson(readSecureOperatorFile(path, MAX_TARGET_FILE_BYTES));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub App target policy is invalid");
  }
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ROOT_KEYS) || root.version !== 1 || !Array.isArray(root.targets)) {
    throw new Error("GitHub App target policy is invalid");
  }
  if (root.targets.length === 0 || root.targets.length > MAX_TARGETS) {
    throw new Error("GitHub App target policy is invalid");
  }
  const targets = new Map<string, GithubAppTarget>();
  for (const value of root.targets) {
    const snapshot = targetSnapshot(value);
    if (targets.has(snapshot.targetKey)) throw new Error("GitHub App target policy is invalid");
    targets.set(
      snapshot.targetKey,
      Object.freeze({ snapshot, digest: digestFeedbackTargetPolicyV1(snapshot) }),
    );
  }
  return immutableTargets(targets);
}

// Readiness preserves disabled, partial, invalid, stale, and ready branches.
// eslint-disable-next-line complexity
export function loadGithubAppConfig(
  input: GithubAppOperatorInput,
  now: Date,
): GithubAppConfigReadiness {
  const values = [
    input.appId,
    input.privateKeyFile,
    input.targetsPolicyFile,
    input.privateKeyRotatedAt,
  ];
  if (values.every((value) => value === undefined)) return { status: "disabled" };
  if (values.some((value) => value === undefined)) {
    return { status: "invalid", reason: "configuration-invalid" };
  }
  try {
    const appId = input.appId ?? "";
    const privateKeyFile = input.privateKeyFile ?? "";
    const rotatedAt = parseRfc3339Timestamp(input.privateKeyRotatedAt ?? "");
    if (!APP_ID.test(appId) || rotatedAt === undefined || !isAbsolute(privateKeyFile))
      throw new Error("invalid");
    validateGithubAppPrivateKeyFile(privateKeyFile);
    const age = now.getTime() - rotatedAt.getTime();
    if (age < 0 || age > 90 * 86_400_000) throw new Error("invalid");
    return Object.freeze({
      status: "ready" as const,
      config: Object.freeze({
        apiOrigin: FEEDBACK_GITHUB_API_ORIGIN_V1,
        appId,
        privateKeyFile,
        privateKeyRotatedAt: rotatedAt.toISOString(),
        targets: loadTargets(input.targetsPolicyFile ?? ""),
      }),
    });
  } catch {
    return { status: "invalid", reason: "configuration-invalid" };
  }
}
