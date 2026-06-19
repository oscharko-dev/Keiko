/**
 * Compile-time enforcement of the content boundary (Issue #1192; ADR-0042 D5/D6).
 *
 * Each content-free contract is asserted at the type level to exclude any content-bearing key. If a
 * field such as `prompt`, `content`, `text`, `newText`, `insertText`, `excerpt`, or `secret` is ever
 * added to one of these types, the matching `const _* = true` line fails to compile, breaking
 * `build`/`typecheck`. These assertions live in a value position so `tsc` checks them; they are not
 * exported and add no runtime surface.
 *
 * Scope: this recursively checks object and array fields of the asserted content-free types. Do not
 * assert reviewable artifact types here: patch edits and completion responses intentionally carry
 * user-reviewable text.
 */
import type {
  EditorCompletionProvenance,
  EditorCompletionRequest,
  EditorContextEntry,
  EditorContextOmission,
  EditorContextPack,
  EditorContextRequest,
  EditorInlineCompletionProvenance,
  EditorInlineCompletionRequest,
  EditorModelProvenance,
  EditorRecentEditContext,
  EditorRecentEditSummary,
  EditorTestGenerationRequest,
} from "./types.js";

type ForbiddenContentKey =
  | "prompt"
  | "rawPrompt"
  | "promptText"
  | "content"
  | "text"
  | "newText"
  | "insertText"
  | "excerpt"
  // `query`/`rawQuery`: ADR-0042 D6 forbids raw retrieval queries from crossing the context port.
  | "query"
  | "rawQuery"
  | "secret"
  | "apiKey"
  | "token"
  | "credential"
  | "authorization";

type Primitive = string | number | boolean | bigint | symbol | null | undefined;

type ForbiddenKeyPaths<T> = T extends Primitive
  ? never
  : T extends readonly (infer Item)[]
    ? ForbiddenKeyPaths<Item>
    : T extends object
      ? {
          [Key in keyof T]-?: Key extends string
            ? Key extends ForbiddenContentKey
              ? Key
              : ForbiddenKeyPaths<T[Key]>
            : never;
        }[keyof T]
      : never;

type AssertNoForbiddenKeys<T> = [ForbiddenKeyPaths<T>] extends [never] ? true : false;

const _modelProvenanceIsContentFree: AssertNoForbiddenKeys<EditorModelProvenance> = true;
const _completionProvenanceIsContentFree: AssertNoForbiddenKeys<EditorCompletionProvenance> = true;
const _completionRequestIsContentFree: AssertNoForbiddenKeys<EditorCompletionRequest> = true;
const _inlineCompletionRequestIsContentFree: AssertNoForbiddenKeys<EditorInlineCompletionRequest> = true;
const _inlineCompletionProvenanceIsContentFree: AssertNoForbiddenKeys<EditorInlineCompletionProvenance> = true;
const _testGenerationRequestIsContentFree: AssertNoForbiddenKeys<EditorTestGenerationRequest> = true;
const _recentEditContextIsContentFree: AssertNoForbiddenKeys<EditorRecentEditContext> = true;
const _recentEditSummaryIsContentFree: AssertNoForbiddenKeys<EditorRecentEditSummary> = true;
const _contextRequestIsContentFree: AssertNoForbiddenKeys<EditorContextRequest> = true;
const _contextEntryIsContentFree: AssertNoForbiddenKeys<EditorContextEntry> = true;
const _contextPackIsContentFree: AssertNoForbiddenKeys<EditorContextPack> = true;
const _contextOmissionIsContentFree: AssertNoForbiddenKeys<EditorContextOmission> = true;

void _modelProvenanceIsContentFree;
void _completionProvenanceIsContentFree;
void _completionRequestIsContentFree;
void _inlineCompletionRequestIsContentFree;
void _inlineCompletionProvenanceIsContentFree;
void _testGenerationRequestIsContentFree;
void _recentEditContextIsContentFree;
void _recentEditSummaryIsContentFree;
void _contextRequestIsContentFree;
void _contextEntryIsContentFree;
void _contextPackIsContentFree;
void _contextOmissionIsContentFree;
