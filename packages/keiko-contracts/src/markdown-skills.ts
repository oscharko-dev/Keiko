/** Private instruction documents. These references confer no execution authority. */
export const MARKDOWN_SKILL_LIMITS = Object.freeze({
  importBytes: 128 * 1024,
  libraryBytes: 16 * 1024 * 1024,
  skills: 128,
  nameChars: 120,
  fileNameChars: 180,
  revisions: 10_000,
});

export interface MarkdownSkillReference {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
}

/** Selection concurrency is independent of the immutable skill revision. */
export interface MarkdownSkillSelection {
  readonly revision: number;
  readonly skill: MarkdownSkillReference | null;
}

export type MarkdownSkillSelectionView =
  | { readonly selection: MarkdownSkillSelection; readonly availability: "none" | "unavailable" }
  | {
      readonly selection: MarkdownSkillSelection;
      readonly availability: "available";
      readonly name: string;
    };

export interface MarkdownSkillMetadata extends MarkdownSkillReference {
  readonly name: string;
  readonly byteCount: number;
  readonly createdAt: number;
}

export interface MarkdownSkillDocument extends MarkdownSkillMetadata {
  readonly body: string;
}

/** Base64 preserves exact upload bytes until the server's strict UTF-8 validation. */
export interface MarkdownSkillUpload {
  readonly fileName: string;
  readonly contentBase64: string;
}

/**
 * Why the server refused to store a Markdown skill, as a closed vocabulary the browser turns into
 * one plain sentence each. A Jira template parse failure keeps its own closed code behind the
 * `template-` prefix. The refusal never carries the person's text, a key name or a path.
 */
export const MARKDOWN_SKILL_REFUSAL_REASONS = [
  "template-marker-misplaced",
  "template-not-a-template",
  "template-front-matter-unterminated",
  "template-malformed-line",
  "template-unknown-key",
  "template-duplicate-key",
  "template-missing-key",
  "template-invalid-value",
  "template-limit-exceeded",
  "template-unsafe-pattern",
  "template-no-rules",
  "text-empty",
  "text-control-characters",
] as const;
export type MarkdownSkillRefusalReason = (typeof MARKDOWN_SKILL_REFUSAL_REASONS)[number];

const REFUSAL_REASONS: ReadonlySet<string> = new Set(MARKDOWN_SKILL_REFUSAL_REASONS);

export function isMarkdownSkillRefusalReason(value: unknown): value is MarkdownSkillRefusalReason {
  return typeof value === "string" && REFUSAL_REASONS.has(value);
}
