/**
 * ResourceLimitDecisionsTable — shared, accessible table of per-dimension
 * resource-limit decisions from a VerificationAuditSummary result entry.
 *
 * Used in both the live run view (run/page.tsx) and the evidence-detail page
 * (evidence/detail/page.tsx) to display appliedLimits from verification results.
 */

import type { ReactNode } from "react";
import type { AuditResultEntry } from "@/lib/types";

interface Props {
  /** The verification result rows whose appliedLimits will be rendered. */
  results: AuditResultEntry[];
}

/**
 * Returns Tailwind classes for the enforced/breached state of a limit cell.
 * Does NOT rely on colour alone — the text also conveys meaning.
 */
function limitCellClasses(enforced: boolean, breached: boolean | undefined): string {
  if (breached === true) return "bg-red-950/40 text-red-300 font-medium";
  if (enforced) return "bg-yellow-950/40 text-yellow-300";
  return "text-ink-muted";
}

export function ResourceLimitDecisionsTable({ results }: Props): ReactNode {
  // Only show the table when at least one result has limits.
  const hasLimits = results.some((r) => r.appliedLimits.length > 0);
  if (!hasLimits) return null;

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="mb-2 text-left text-xs font-medium text-ink-muted">
          Resource-limit decisions
        </caption>
        <thead>
          <tr className="border-b border-ink/10 text-left">
            <th scope="col" className="pb-1.5 pr-4 font-medium text-ink-muted">
              Step
            </th>
            <th scope="col" className="pb-1.5 pr-4 font-medium text-ink-muted">
              Dimension
            </th>
            <th scope="col" className="pb-1.5 pr-4 font-medium text-ink-muted">
              Limit
            </th>
            <th scope="col" className="pb-1.5 pr-4 font-medium text-ink-muted">
              Enforced
            </th>
            <th scope="col" className="pb-1.5 font-medium text-ink-muted">
              Breached
            </th>
          </tr>
        </thead>
        <tbody>
          {results.flatMap((r) =>
            r.appliedLimits.map((lim) => {
              const breached = lim.breached === true;
              const rowKey = `${r.kind}-${r.command}-${lim.dimension}`;
              return (
                <tr
                  key={rowKey}
                  className={`border-b border-ink/10 ${breached ? "bg-red-950/20" : ""}`}
                >
                  <td className="py-1.5 pr-4 font-mono text-ink-muted">{r.command}</td>
                  <td className="py-1.5 pr-4 font-mono">{lim.dimension}</td>
                  <td className="py-1.5 pr-4 font-mono">{lim.limit.toString()}</td>
                  <td className={`py-1.5 pr-4 ${limitCellClasses(lim.enforced, lim.breached)}`}>
                    {lim.enforced ? "Yes" : "No"}
                  </td>
                  <td className={`py-1.5 ${limitCellClasses(lim.enforced, lim.breached)}`}>
                    {breached ? "Yes (breached)" : "No"}
                    {lim.note !== undefined && lim.note !== "" && (
                      <span className="ml-1 text-ink-muted">— {lim.note}</span>
                    )}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
