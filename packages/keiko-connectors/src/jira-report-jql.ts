const ORDER_BY = /^order\s+by\b/iu;

/** Walks the JQL outside quoted strings; the visitor may stop the walk by returning true. */
function walkOutsideQuotes(
  jql: string,
  visit: (char: string, index: number) => boolean | undefined,
): { readonly closed: boolean; readonly stoppedAt: number | undefined } {
  let quote: string | undefined;
  for (let index = 0; index < jql.length; index += 1) {
    const char = jql.charAt(index);
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (visit(char, index) === true) return { closed: true, stoppedAt: index };
  }
  return { closed: quote === undefined, stoppedAt: undefined };
}

/** Ordering outside quotes is replaced by the report's own stable ordering. */
export function stripJqlOrdering(jql: string): string {
  const { stoppedAt } = walkOutsideQuotes(
    jql,
    (_char, index) =>
      (index === 0 || /[\s)]/u.test(jql.charAt(index - 1))) && ORDER_BY.test(jql.slice(index)),
  );
  return (stoppedAt === undefined ? jql : jql.slice(0, stoppedAt)).trim();
}

/**
 * Parentheses balance outside quoted strings and no quote is left open. An unbalanced clause such
 * as `x) OR (y` would otherwise leave the project scope the report adds around it.
 */
export function jqlIsBalanced(jql: string): boolean {
  let depth = 0;
  const { closed } = walkOutsideQuotes(jql, (char) => {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    return depth < 0;
  });
  return closed && depth === 0;
}

/** The caller's clause without ordering, or undefined when it is unusable as a scope part. */
export function jqlClause(jql: string): string | undefined {
  const clause = stripJqlOrdering(jql);
  return jqlIsBalanced(clause) ? clause : undefined;
}

/** The effective query: the project and the caller's clause, in a stable order. */
export function reportJql(projectKey: string | undefined, jql: string | undefined): string {
  const clause = jql === undefined ? "" : stripJqlOrdering(jql);
  const parts = [
    ...(projectKey === undefined ? [] : [`project = "${projectKey}"`]),
    ...(clause.length === 0 ? [] : [projectKey === undefined ? clause : `(${clause})`]),
  ];
  return `${parts.join(" AND ")} ORDER BY key ASC`;
}
