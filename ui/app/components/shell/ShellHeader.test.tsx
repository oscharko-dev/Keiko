import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { ShellHeader } from "./ShellHeader";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("ShellHeader", () => {
  it("renders <header> content via banner role (rendered inside a header by ShellChrome)", () => {
    // ShellHeader renders its content; the banner role comes from ShellChrome's <header>.
    // Here we verify the secondary nav and toggle are present.
    render(<ShellHeader collapsed={false} onToggle={vi.fn()} />);
    expect(screen.getByRole("navigation", { name: /secondary navigation/i })).toBeInTheDocument();
  });

  it("toggle button has correct aria-expanded when expanded", () => {
    render(<ShellHeader collapsed={false} onToggle={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /collapse sidebar/i });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(btn).toHaveAttribute("aria-controls", "shell-sidebar");
  });

  it("toggle button has correct aria-expanded when collapsed", () => {
    render(<ShellHeader collapsed={true} onToggle={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /expand sidebar/i });
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("calls onToggle when toggle button is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ShellHeader collapsed={false} onToggle={onToggle} />);
    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("focus stays on toggle button after click (does not displace focus)", async () => {
    const user = userEvent.setup();
    render(<ShellHeader collapsed={false} onToggle={vi.fn()} />);
    const btn = screen.getByRole("button", { name: /collapse sidebar/i });
    await user.click(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("renders Config and Evidence secondary nav links", () => {
    render(<ShellHeader collapsed={false} onToggle={vi.fn()} />);
    expect(screen.getByRole("link", { name: /config/i })).toHaveAttribute("href", "/config");
    expect(screen.getByRole("link", { name: /evidence/i })).toHaveAttribute("href", "/evidence");
  });

  it("has no axe-detectable accessibility violations", async () => {
    // aria-controls references shell-sidebar which exists in ShellChrome's tree, not here in
    // isolation. Disable aria-valid-attr-value to avoid a false positive in unit test context.
    const { container } = render(<ShellHeader collapsed={false} onToggle={vi.fn()} />);
    const results = await axe(container, {
      rules: { "aria-valid-attr-value": { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
