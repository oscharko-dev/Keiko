// Shared complete-token path grammar, relocated from the existing workflow planner.
const PATH_TOKEN_RE = /[^\s`"'<>,;!?]+/gu;
function completePathToken(raw: string): string {
  const term = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (term.startsWith("(") && term.endsWith(")")) return term.slice(1, -1);
  return term.endsWith(")") ? term.slice(0, -1) : term;
}

function isFilePathToken(term: string): boolean {
  const path = term.replace(/(?::\d{1,9}){1,2}$/u, "");
  if (!path.includes("/") || path.includes("\\")) return false;
  const localPath = path.startsWith("file://") ? path.slice(7) : path;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(localPath)) return false;
  const name = localPath.slice(localPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && /^[A-Za-z0-9]{1,16}$/u.test(name.slice(dot + 1));
}

// The composer emits @path as a reference marker. Quotes have already been consumed here;
// quoted literal @ paths and an explicit ./@ path therefore retain their filesystem spelling.
export function normalizeUnquotedFilePathToken(term: string): string {
  const withoutMention = term.startsWith("@") ? term.slice(1) : term;
  return isFilePathToken(withoutMention) ? withoutMention : term;
}

export function mapUnquotedRepositoryFilePaths(
  source: string,
  replace: (term: string, raw: string) => string,
): string {
  return source.replace(PATH_TOKEN_RE, (raw: string) => {
    const term = normalizeUnquotedFilePathToken(completePathToken(raw));
    return isFilePathToken(term) ? replace(term, raw) : raw;
  });
}
