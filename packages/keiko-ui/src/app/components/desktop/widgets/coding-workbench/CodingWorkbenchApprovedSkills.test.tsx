import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import type { SkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts";
import { validateSkillDiscoveryResultV1 } from "@oscharko-dev/keiko-contracts/runtime/coding-skill-discovery";
import { ApprovedSkillsDisclosure } from "./CodingWorkbenchApprovedSkills";

function listing(skills: readonly Record<string, unknown>[]): SkillDiscoveryResultV1 {
  const validated = validateSkillDiscoveryResultV1({
    schemaVersion: 1,
    catalogDigest: "a".repeat(64),
    skills,
  });
  if (!validated.ok) throw new Error(`fixture is not a listing: ${validated.errors.join(", ")}`);
  return validated.value;
}

function skill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skillId: "skl_repo-structure-summary@1",
    version: "1",
    sourceDigest: "b".repeat(64),
    category: "repository-analysis",
    capabilities: ["keiko.workspace.read"],
    compatibility: { profile: "opencode", minVersion: 1, maxVersion: 1 },
    readiness: { state: "ready" },
    ...overrides,
  };
}

describe("ApprovedSkillsDisclosure (#3417)", () => {
  it("names every approved skill with its category and readiness", () => {
    render(
      <ApprovedSkillsDisclosure
        skills={listing([
          skill(),
          skill({
            skillId: "skl_release-notes@2",
            version: "2",
            category: "documentation-lookup",
            readiness: { state: "unavailable", reason: "budget-exhausted" },
          }),
        ])}
      />,
    );

    expect(screen.getByText("Approved skills (2)")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("skl_repo-structure-summary@1");
    expect(rows[0]).toHaveTextContent("Repository analysis");
    expect(rows[0]).toHaveTextContent("Ready");
    expect(rows[1]).toHaveTextContent("skl_release-notes@2");
    expect(rows[1]).toHaveTextContent("Documentation lookup");
    expect(rows[1]).toHaveTextContent("Budget exhausted");
  });

  it("shows nothing at all when the run has no listing or an empty one", () => {
    const { container, rerender } = render(<ApprovedSkillsDisclosure skills={undefined} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<ApprovedSkillsDisclosure skills={listing([])} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("carries no skill body, path or prompt, only the closed record", () => {
    const { container } = render(<ApprovedSkillsDisclosure skills={listing([skill()])} />);

    expect(container.textContent).not.toContain("b".repeat(64));
    expect(container.textContent).not.toContain("keiko.workspace.read");
  });

  it("has no serious or critical axe violations", async () => {
    const { container } = render(<ApprovedSkillsDisclosure skills={listing([skill()])} />);

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
