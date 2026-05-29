"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { fetchEvidenceList, ApiError } from "@/lib/api";
import type { EvidenceListEntry } from "@/lib/types";
import { formatDate, outcomeClasses, outcomeLabel, toDateString } from "@/lib/format";

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

interface Filters {
  workflow: string;
  outcome: string;
  date: string;
}

interface FilterBarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
}

const OUTCOMES = ["", "completed", "cancelled", "failed", "limit-exceeded"] as const;
const WORKFLOWS = ["", "generate-unit-tests", "investigate-bug", "explain-plan"] as const;

function FilterBar({ filters, onChange }: FilterBarProps): ReactNode {
  return (
    <form
      role="search"
      aria-label="Filter evidence runs"
      className="flex flex-wrap gap-3"
      onSubmit={(e) => { e.preventDefault(); }}
    >
      <div>
        <label htmlFor="filter-workflow" className="block text-xs text-ink-muted">
          Workflow
        </label>
        <select
          id="filter-workflow"
          value={filters.workflow}
          onChange={(e) => { onChange({ ...filters, workflow: e.target.value }); }}
          className="mt-1 rounded border border-ink/20 bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus"
        >
          {WORKFLOWS.map((w) => (
            <option key={w || "all"} value={w}>
              {w || "All workflows"}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="filter-outcome" className="block text-xs text-ink-muted">
          Outcome
        </label>
        <select
          id="filter-outcome"
          value={filters.outcome}
          onChange={(e) => { onChange({ ...filters, outcome: e.target.value }); }}
          className="mt-1 rounded border border-ink/20 bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus"
        >
          {OUTCOMES.map((o) => (
            <option key={o || "all"} value={o}>
              {o || "All outcomes"}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="filter-date" className="block text-xs text-ink-muted">
          Date (YYYY-MM-DD)
        </label>
        <input
          type="date"
          id="filter-date"
          value={filters.date}
          onChange={(e) => { onChange({ ...filters, date: e.target.value }); }}
          className="mt-1 rounded border border-ink/20 bg-surface px-2 py-1 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Evidence list table
// ---------------------------------------------------------------------------

interface EvidenceListProps {
  entries: EvidenceListEntry[];
}

function EvidenceList({ entries }: EvidenceListProps): ReactNode {
  if (entries.length === 0) {
    return (
      <p className="mt-6 text-sm text-ink-muted">
        No evidence entries match the current filters.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Evidence run list, newest first</caption>
        <thead>
          <tr className="border-b border-ink/10 text-left text-xs text-ink-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Run ID</th>
            <th scope="col" className="py-2 pr-4 font-medium">Workflow</th>
            <th scope="col" className="py-2 pr-4 font-medium">Outcome</th>
            <th scope="col" className="py-2 pr-4 font-medium">Started</th>
            <th scope="col" className="py-2 font-medium">Finished</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.runId}
              className="border-b border-ink/10 hover:bg-surface-subtle"
            >
              <td className="py-2 pr-4">
                <Link
                  href={`/evidence/detail?id=${encodeURIComponent(entry.runId)}`}
                  className="font-mono text-xs text-accent hover:underline focus:outline-none focus:ring-1 focus:ring-focus"
                >
                  {entry.runId}
                </Link>
              </td>
              <td className="py-2 pr-4 text-ink-muted">{entry.taskType}</td>
              <td className="py-2 pr-4">
                <span
                  className={`rounded px-2 py-0.5 text-xs font-medium ${outcomeClasses(entry.outcome)}`}
                >
                  {outcomeLabel(entry.outcome)}
                </span>
              </td>
              <td className="py-2 pr-4 text-ink-muted">{formatDate(entry.startedAt)}</td>
              <td className="py-2 text-ink-muted">{formatDate(entry.finishedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EvidencePage
// ---------------------------------------------------------------------------

function clientFilter(entries: EvidenceListEntry[], filters: Filters): EvidenceListEntry[] {
  return entries.filter((e) => {
    if (filters.workflow !== "" && e.taskType !== filters.workflow) return false;
    if (filters.outcome !== "" && e.outcome !== filters.outcome) return false;
    if (filters.date !== "") {
      // FIX F: startedAt is epoch-ms (number). Derive the YYYY-MM-DD date string
      // from the epoch-ms value and compare — never call .startsWith on a number.
      if (toDateString(e.startedAt) !== filters.date) return false;
    }
    return true;
  });
}

export default function EvidencePage(): ReactNode {
  const [allEntries, setAllEntries] = useState<EvidenceListEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>({ workflow: "", outcome: "", date: "" });

  useEffect(() => {
    let active = true;
    fetchEvidenceList()
      .then(({ entries }) => {
        if (!active) return;
        // Newest-first sort by finishedAt (epoch-ms numbers — direct subtraction is safe)
        const sorted = [...entries].sort((a, b) => b.finishedAt - a.finishedAt);
        setAllEntries(sorted);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        const msg = err instanceof ApiError ? err.message : "Failed to load evidence";
        setLoadError(msg);
        setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const visible = clientFilter(allEntries, filters);

  return (
    <section aria-labelledby="evidence-heading">
      <h1 id="evidence-heading" className="text-heading text-ink">
        Evidence browser
      </h1>
      <p className="mt-2 text-sm text-ink-muted">
        Browse past runs and their evidence manifests. Filter by workflow, outcome, or date.
      </p>

      {loadError !== null && (
        <p role="alert" className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </p>
      )}

      {!loading && loadError === null && (
        <>
          <div className="mt-6">
            <FilterBar filters={filters} onChange={setFilters} />
          </div>

          <div aria-live="polite" aria-atomic="true" className="sr-only">
            {visible.length.toString()} run{visible.length !== 1 ? "s" : ""} shown
          </div>

          <EvidenceList entries={visible} />
        </>
      )}

      {loading && (
        <p className="mt-4 text-ink-muted" aria-busy="true">
          Loading evidence…
        </p>
      )}
    </section>
  );
}
