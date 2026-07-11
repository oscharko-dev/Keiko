import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { BrowserContext, Page } from "@playwright/test";

// GEN-TEST-E2E-004 — shared real-browser axe-core runner. The a11y estate before this was one
// coordinator-only axe suite (update-ui-1696, wired into no CI job) plus jsdom-only component axe.
// Real-browser-only a11y failures (focus order, roving tabindex, live-region wiring, contrast in
// computed styles) can ONLY be caught here, so this lifts the update-ui runner into a reusable
// module the a11y smoke consumes. Uses the committed axe-core/axe.min.js (no network, no new dep).

const AXE_SOURCE = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

// WCAG 2.0/2.1/2.2 A + AA, matching the update-ui evidence gate.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

export async function installAxe(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: AXE_SOURCE });
}

// Runs axe over the element matched by `selector` and returns every violation. Callers decide which
// impact levels are gating (the smoke gate fails on serious/critical, matching the W10 criterion).
export async function runAxe(page: Page, selector: string): Promise<readonly AxeViolation[]> {
  const installed = await page.evaluate(() => "axe" in window);
  if (!installed) await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ rootSelector, tags }) => {
      const root = document.querySelector(rootSelector);
      if (root === null) throw new Error(`Axe target not found: ${rootSelector}`);
      const axeRunner = (
        window as unknown as {
          readonly axe: {
            readonly run: (
              context: Element,
              options: {
                readonly runOnly: { readonly type: "tag"; readonly values: readonly string[] };
              },
            ) => Promise<{
              readonly violations: readonly {
                readonly id: string;
                readonly impact: string | null;
                readonly help: string;
                readonly nodes: readonly { readonly target: readonly string[] }[];
              }[];
            }>;
          };
        }
      ).axe;
      const result = await axeRunner.run(root, { runOnly: { type: "tag", values: tags } });
      return result.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({ target: node.target })),
      }));
    },
    { rootSelector: selector, tags: [...WCAG_TAGS] },
  );
}

// The W10 gate criterion: zero serious/critical violations. Moderate/minor are surfaced in the
// message for triage but do not fail the smoke (they are tracked separately in the #1300 evidence).
export function seriousOrCritical(violations: readonly AxeViolation[]): readonly AxeViolation[] {
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

export function formatViolations(violations: readonly AxeViolation[]): string {
  if (violations.length === 0) return "none";
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? "n/a"}): ${v.help} @ ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    )
    .join("\n");
}
