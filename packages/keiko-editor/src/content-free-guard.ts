/**
 * Compile-time enforcement of the content boundary (Issue #1192; ADR-0042 D5/D6).
 *
 * Each content-free contract is asserted at the type level to exclude any content-bearing key. If a
 * field such as `prompt`, `content`, `text`, `excerpt`, or `secret` is ever added to one of these
 * types, the matching `const _* = true` line fails to compile, breaking `build`/`typecheck`. These
 * assertions live in a value position so `tsc` checks them; they are not exported and add no runtime
 * surface.
 *
 * Scope: this is a shallow check over each type's own keys. A nested object typed as another
 * interface must be listed here independently (as `EditorContextEntry` is, even though it only
 * appears nested in `EditorContextPack`). The recursive runtime scan in `types.test.ts` is the
 * defence-in-depth layer that descends into populated nested fixtures.
 */
import type {
  EditorContextEntry,
  EditorContextOmission,
  EditorContextPack,
  EditorContextRequest,
  EditorModelProvenance,
} from "./types.js";

type ForbiddenContentKey =
  | "prompt"
  | "rawPrompt"
  | "promptText"
  | "content"
  | "text"
  | "excerpt"
  // `query`/`rawQuery`: ADR-0042 D6 forbids raw retrieval queries from crossing the context port.
  | "query"
  | "rawQuery"
  | "secret"
  | "apiKey"
  | "token"
  | "credential"
  | "authorization";

type AssertNoForbiddenKeys<T> = Extract<keyof T, ForbiddenContentKey> extends never ? true : false;

const _modelProvenanceIsContentFree: AssertNoForbiddenKeys<EditorModelProvenance> = true;
const _contextRequestIsContentFree: AssertNoForbiddenKeys<EditorContextRequest> = true;
const _contextEntryIsContentFree: AssertNoForbiddenKeys<EditorContextEntry> = true;
const _contextPackIsContentFree: AssertNoForbiddenKeys<EditorContextPack> = true;
const _contextOmissionIsContentFree: AssertNoForbiddenKeys<EditorContextOmission> = true;

void _modelProvenanceIsContentFree;
void _contextRequestIsContentFree;
void _contextEntryIsContentFree;
void _contextPackIsContentFree;
void _contextOmissionIsContentFree;
