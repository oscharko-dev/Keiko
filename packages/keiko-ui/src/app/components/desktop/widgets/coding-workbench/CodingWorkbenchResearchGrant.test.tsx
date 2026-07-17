import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchRuntimeResearchGrant } from "@oscharko-dev/keiko-contracts";
import { ResearchGrantChip } from "./CodingWorkbenchResearchGrant";

const REVOKE_NAME = "Revoke the internet research grant for this run and its child agents";

function grant(
  overrides: Partial<CodingWorkbenchRuntimeResearchGrant> = {},
): CodingWorkbenchRuntimeResearchGrant {
  return {
    grantId: "grant-1",
    domains: ["developer.mozilla.org", "nodejs.org"],
    expiresAt: "2026-07-13T12:30:00.000Z",
    ...overrides,
  };
}

describe("ResearchGrantChip", () => {
  it("renders the content-free scope, joined domains, and verbatim expiry", () => {
    render(<ResearchGrantChip grant={grant()} busy={false} onRevoke={vi.fn()} />);

    const group = screen.getByRole("group", { name: "Internet · Research only" });
    expect(group).toHaveTextContent("Public research only");
    expect(group).toHaveTextContent("developer.mozilla.org, nodejs.org");
    expect(group).toHaveTextContent("2026-07-13T12:30:00.000Z");
  });

  it("revokes once when the enabled control is activated", async () => {
    const user = userEvent.setup();
    const onRevoke = vi.fn();
    render(<ResearchGrantChip grant={grant()} busy={false} onRevoke={onRevoke} />);

    const revoke = screen.getByRole("button", { name: REVOKE_NAME });
    expect(revoke).toBeEnabled();
    await user.click(revoke);
    expect(onRevoke).toHaveBeenCalledOnce();
  });

  it("disables the control and shows progress while a mutation is pending", () => {
    render(<ResearchGrantChip grant={grant()} busy onRevoke={vi.fn()} />);

    const revoke = screen.getByRole("button", { name: REVOKE_NAME });
    expect(revoke).toBeDisabled();
    expect(revoke).toHaveTextContent("Revoking…");
  });

  it("renders nothing when no grant is present", () => {
    const { container } = render(
      <ResearchGrantChip grant={undefined} busy={false} onRevoke={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("has no serious or critical axe violations", async () => {
    const { container } = render(
      <ResearchGrantChip grant={grant()} busy={false} onRevoke={vi.fn()} />,
    );

    const report = await axe(container);
    expect(
      report.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
