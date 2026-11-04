import { createHash } from "node:crypto";
import {
  MARKDOWN_SKILL_LIMITS,
  type MarkdownSkillUpload,
} from "@oscharko-dev/keiko-contracts/bff-wire";
import {
  describeJiraTemplateParseErrors,
  isJiraIssueTemplateDocument,
  mentionsJiraIssueTemplateMarker,
  parseJiraIssueTemplate,
} from "@oscharko-dev/keiko-contracts/runtime/atlassian-connectors";
import { invalidRequest, UiStoreError } from "./errors.js";

export interface ValidatedMarkdownSkill {
  readonly name: string;
  readonly body: string;
  readonly digest: string;
  readonly byteCount: number;
}

export function markdownSkillDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function assertMarkdownSkillIdentity(id: string, revision?: number): void {
  if (!/^msk_[a-f0-9-]{36}$/u.test(id)) throw invalidRequest("Invalid skill identity.");
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw invalidRequest("Invalid skill revision.");
  }
}

function validateFileName(name: string): void {
  if (
    name.length > MARKDOWN_SKILL_LIMITS.fileNameChars ||
    /\p{Cs}/u.test(name) ||
    !/^[^/\\\p{Cc}]+\.md$/iu.test(name) ||
    name.slice(0, -3).trim().length === 0 ||
    name.startsWith(".") ||
    name.includes(":")
  )
    throw invalidRequest("Upload a Markdown filename without a directory.");
}

function decodeUpload(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw invalidRequest("Invalid skill encoding.");
  if (bytes.byteLength > MARKDOWN_SKILL_LIMITS.importBytes) {
    throw new UiStoreError("INVALID_REQUEST", "Skill file exceeds the upload limit.", 413);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/gu, "\n");
  } catch {
    throw invalidRequest("Skill file must be valid UTF-8.");
  }
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split("\n")) {
    if (!line.startsWith("# ") && !line.startsWith("#\t")) continue;
    const heading = line.slice(2).trim();
    if (heading.length > 0) return heading;
  }
  return undefined;
}

function boundedDisplayName(value: string): string {
  const bounded = value.slice(0, MARKDOWN_SKILL_LIMITS.nameChars);
  return /\p{Cs}/u.test(bounded) ? bounded.slice(0, -1) : bounded;
}

/** A document that declares itself a Jira issue template must be one: it becomes enforcement. */
function assertValidJiraTemplate(body: string): void {
  if (!isJiraIssueTemplateDocument(body)) {
    // A marker line that is not in a front matter at the very top would silently govern nothing.
    if (mentionsJiraIssueTemplateMarker(body)) {
      throw invalidRequest(
        "Jira issue template marker without a valid front matter: start the file with ---.",
      );
    }
    return;
  }
  const parsed = parseJiraIssueTemplate(body);
  if (!parsed.ok) {
    throw invalidRequest(
      `Jira issue template is invalid: ${describeJiraTemplateParseErrors(parsed.errors)}.`,
    );
  }
}

export function validateMarkdownSkillUpload(input: MarkdownSkillUpload): ValidatedMarkdownSkill {
  validateFileName(input.fileName);
  if (input.contentBase64.length > Math.ceil(MARKDOWN_SKILL_LIMITS.importBytes / 3) * 4) {
    throw new UiStoreError("INVALID_REQUEST", "Skill file exceeds the upload limit.", 413);
  }
  const body = decodeUpload(input.contentBase64);
  if (body.trim().length === 0 || /\p{Cc}/u.test(body.replace(/[\n\t]/gu, ""))) {
    throw invalidRequest("Skill file must contain nonempty Markdown text.");
  }
  assertValidJiraTemplate(body);
  const heading = firstHeading(body);
  const name = boundedDisplayName(heading ?? input.fileName.slice(0, -3));
  return { name, body, digest: markdownSkillDigest(body), byteCount: Buffer.byteLength(body) };
}
