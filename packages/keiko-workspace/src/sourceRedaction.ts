import { extname } from "node:path";
import { redact } from "@oscharko-dev/keiko-security";
import { isEcosystemSourceFile, workspaceLanguageForPath } from "./ecosystems.js";
import { WorkspaceReadError } from "./errors.js";

/** Evidence retains language syntax; metadata and non-source files keep plain-text protection. */
export function redactWorkspaceSource(
  text: string,
  scopePath: string,
  preserveSourceLineBreaks = true,
): string {
  const sourceFile = isEcosystemSourceFile(scopePath);
  const language = sourceFile ? workspaceLanguageForPath(scopePath) : undefined;
  const sourceLanguage =
    language === "typescript" || language === "javascript" || language === "java"
      ? language
      : DOCUMENT_FORMATS.get(extname(scopePath).toLowerCase());
  if (hasUnsupportedCsharpLiteral(language, text))
    throw new WorkspaceReadError("code source redaction is unavailable", scopePath);
  const status = { unavailable: false };
  const safe = redact(text, [], {
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
