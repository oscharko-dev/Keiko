import { extname } from "node:path";
import { contentRedactionEnabled, redactContent } from "@oscharko-dev/keiko-security";
import { isEcosystemSourceFile, workspaceLanguageForPath } from "./ecosystems.js";
import { WorkspaceReadError } from "./errors.js";

/**
 * Evidence retains language syntax; metadata and non-source files keep plain-text protection. The
 * one model-safe projection of workspace text: discovery, search and import reads use it here, and
 * a consumer that receives workspace text from another read boundary (the Coding runtime's secure
 * read helper, say) imports it through the `./source-redaction` subpath instead of a second copy.
 * Throws `WorkspaceReadError` when no safe projection is available, so callers fail closed.
 */
export function redactWorkspaceSource(
  text: string,
  scopePath: string,
  preserveSourceLineBreaks = true,
): string {
  if (!contentRedactionEnabled()) return redactContent(text);
  const sourceFile = isEcosystemSourceFile(scopePath);
  const language = sourceFile ? workspaceLanguageForPath(scopePath) : undefined;
  const sourceLanguage = projectionLanguage(language, scopePath);
  if (hasUnsupportedCsharpLiteral(language, text))
    throw new WorkspaceReadError("code source redaction is unavailable", scopePath);
  const status = { unavailable: false };
  const safe = redactContent(text, [], {
    preserveSourceLineBreaks,
    inferSourceLanguage: !sourceFile || sourceLanguage !== undefined,
    ...(sourceLanguage === undefined ? {} : { sourceLanguage }),
    onCodeProjection: (report): void => {
      status.unavailable ||= report.depthRefusals + report.sizeRefusals + report.syntaxRefusals > 0;
    },
  });
  if (status.unavailable)
    throw new WorkspaceReadError("code source redaction is unavailable", scopePath);
  return safe;
}

function projectionLanguage(
  language: ReturnType<typeof workspaceLanguageForPath>,
  scopePath: string,
): "typescript" | "javascript" | "java" | "json" | "yaml" | undefined {
  return language === "typescript" || language === "javascript" || language === "java"
    ? language
    : DOCUMENT_FORMATS.get(extname(scopePath).toLowerCase());
}

function hasUnsupportedCsharpLiteral(
  language: ReturnType<typeof workspaceLanguageForPath>,
  text: string,
): boolean {
  return language === "csharp" && /[@$]"|"{3}|\\[uUxX][\da-fA-F]/u.test(text);
}

// This selects a parser for already admitted bytes; discovery/authority/ranking stay with ecosystems.
const DOCUMENT_FORMATS: ReadonlyMap<string, "json" | "yaml"> = new Map([
  [".json", "json"],
  [".jsonc", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
]);
