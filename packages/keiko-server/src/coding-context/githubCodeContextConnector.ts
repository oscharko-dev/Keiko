import type { CommandRule } from "@oscharko-dev/keiko-tools";

import {
  buildGitHubCodeContextArgv,
  buildGitHubCodeContextCommentsArgv,
  type CodeContextConnector,
  type CodeContextRawComment,
  type CodeContextRawObject,
  type CodeContextRef,
  type GitHubCodeContextRef,
} from "./codeContextConnector.js";

export interface GitHubCodeContextApiPort {
  readJson(argv: readonly string[]): Promise<unknown>;
}

export const GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS: readonly string[] = Object.freeze(["api"]);

export const GITHUB_CODE_CONTEXT_COMMAND_RULES: readonly CommandRule[] = Object.freeze([
  {
    executable: "gh",
    allowedSubcommands: GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS,
    valueFlags: Object.freeze(["--method", "-X", "--hostname", "--jq", "-q", "-H", "--header"]),
    denyFlags: Object.freeze(["--input", "--paginate", "-f", "--raw-field", "-F", "--field"]),
  },
]);

export function createGitHubCodeContextConnector(
  api: GitHubCodeContextApiPort,
): CodeContextConnector {
  return {
    read: async (ref): Promise<CodeContextRawObject> => readGitHubCodeContext(api, ref),
  };
}

export function gitHubCodeContextArgvIsGoverned(argv: readonly string[]): boolean {
  return argv.length > 0 && GITHUB_CODE_CONTEXT_ALLOWED_SUBCOMMANDS.includes(argv[0] ?? "");
}

async function readGitHubCodeContext(
  api: GitHubCodeContextApiPort,
  ref: CodeContextRef,
): Promise<CodeContextRawObject> {
  const githubRef = assertGitHubRef(ref);
  const [objectJson, commentsJson] = await Promise.all([
    api.readJson(buildGitHubCodeContextArgv(githubRef)),
    api.readJson(buildGitHubCodeContextCommentsArgv(githubRef)),
  ]);
  return rawObjectFromGitHub(githubRef, objectJson, commentsJson);
}

function assertGitHubRef(ref: CodeContextRef): GitHubCodeContextRef {
  if (ref.source !== "github") throw new Error("GitHub connector received non-GitHub ref");
  return ref;
}

function rawObjectFromGitHub(
  ref: GitHubCodeContextRef,
  objectJson: unknown,
  commentsJson: unknown,
): CodeContextRawObject {
  const object = asRecord(objectJson, "GitHub object");
  return {
    source: "github",
    objectKind: ref.objectKind,
    objectId: ref.objectId,
    title: optionalString(object.title),
    body: optionalString(object.body),
    comments: commentsFromGitHub(commentsJson),
    url: optionalString(object.url),
  };
}

function commentsFromGitHub(value: unknown): readonly CodeContextRawComment[] {
  if (!Array.isArray(value)) throw new Error("GitHub comments response must be an array");
  return value.map((entry) => {
    const comment = asRecord(entry, "GitHub comment");
    return { id: optionalString(comment.id), body: optionalString(comment.body) };
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} response must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
