// a11y smoke tests for the RunLauncher connected-source banner (Epic #709, Issue #714 — "the
// connected-source banner states file vs folder accessibly"). jest-axe runs the WCAG 2.2 AA rule
// set; the launcher MUST emit zero violations whether it is bound to a single file, a single folder,
// or several connected sources (N+1). The file-vs-folder distinction must be carried by TEXT, not by
// colour or icon alone, so a screen-reader user knows what Generate will run against.

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";
import { RunLauncher } from "./RunLauncher";

describe("RunLauncher connected-source banner — a11y (WCAG 2.2 AA)", () => {
  it("has no violations and names the file when bound to a single Fachkonzept file", async () => {
    const { container } = render(
      <RunLauncher connectedFilePath="/work/spec/urlaubsantrag-workflow.md" />,
    );
    const banner = await screen.findByTestId("qi-connected-source");
    // The kind ("Connected file") and the path are plain text — colour/icon are not the only signal.
    expect(banner.textContent).toContain("Connected file");
    expect(banner.textContent).toContain("/work/spec/urlaubsantrag-workflow.md");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations and names the folder when bound to a single folder (no focused file)", async () => {
    const { container } = render(<RunLauncher connectedRoot="/work/spec" />);
    const banner = await screen.findByTestId("qi-connected-source");
    expect(banner.textContent).toContain("Connected folder");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations and names the capsule when bound to a single Connector capsule (#710 #718)", async () => {
    const { container } = render(<RunLauncher connectedCapsuleIds={["cap-policy"]} />);
    const banner = await screen.findByTestId("qi-connected-source");
    // The capsule id is opaque, so the kind ("Connected capsule") MUST be carried by text — a
    // screen-reader user otherwise cannot tell what Generate will run against.
    expect(banner.textContent).toContain("Connected capsule");
    expect(banner.textContent).toContain("cap-policy");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations and names the capsule set when bound to a single capsule-set (#710 #718)", async () => {
    const { container } = render(<RunLauncher connectedCapsuleSetIds={["set-regulatory"]} />);
    const banner = await screen.findByTestId("qi-connected-source");
    expect(banner.textContent).toContain("Connected capsule set");
    expect(banner.textContent).toContain("set-regulatory");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no violations with several connected sources (N+1 list)", async () => {
    const { container } = render(
      <RunLauncher
        connectedFilePath="/work/spec/urlaubsantrag-workflow.md"
        connectedRoots={["/work/other-folder"]}
        connectedCapsuleIds={["cap-policy"]}
      />,
    );
    // The N+1 case renders an accessible list of every connected source.
    expect(await screen.findByRole("list", { name: /connected sources/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
