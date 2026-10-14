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
