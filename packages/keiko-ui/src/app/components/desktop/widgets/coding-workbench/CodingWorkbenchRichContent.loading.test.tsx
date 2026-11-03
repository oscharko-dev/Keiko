import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientDiagnosticMeta } from "@/lib/client-diagnostics";

// The KaTeX chunk is lazy. These tests hold its import open, and make it fail, to prove what a
// reader sees meanwhile and after: the formulas as written, never a blank or a broken answer.

type Diagnostic = readonly [string, ClientDiagnosticMeta | undefined];

interface KatexImport {
  readonly imports: () => number;
  readonly release: () => void;
}

// Installs a fresh stand-in for the `katex` module and a fresh module registry, so the loader's
// page-lifetime cache starts empty in every test.
function mockKatex(mode: "hold" | "fail"): KatexImport {
  let imports = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.resetModules();
  vi.doMock("katex", async () => {
    imports += 1;
    if (mode === "fail") throw new TypeError("Failed to fetch dynamically imported module");
    await gate;
    return vi.importActual("katex");
  });
  return { imports: () => imports, release: () => release() };
}

describe("lazy KaTeX loading", () => {
  const diagnostics: Diagnostic[] = [];

  beforeEach(() => {
    diagnostics.length = 0;
  });

  afterEach(() => {
    vi.doUnmock("katex");
    vi.resetModules();
  });

  async function freshAnswer(source: string): Promise<HTMLElement> {
    // Every module below belongs to the registry `mockKatex` just reset, the diagnostic sink too.
    const [{ SafeMarkdownBoundary }, { CODING_WORKBENCH_RICH_CONTENT }, sink] = await Promise.all([
      import("../../SafeMarkdown"),
      import("./CodingWorkbenchRichContent"),
      import("@/lib/client-diagnostics"),
    ]);
    sink.setClientDiagnosticWriter((message, meta) => {
      diagnostics.push([message, meta]);
    });
    return render(
      <SafeMarkdownBoundary source={source} richContent={CODING_WORKBENCH_RICH_CONTENT} />,
    ).container;
  }

  it("shows formulas and fences as written until KaTeX arrives, then typesets them", async () => {
    const katex = mockKatex("hold");
    const container = await freshAnswer("Inline $x^2$ and\n\n```math\n\\frac{a}{b}\n```");
    expect(container.querySelector('[data-math-state="pending"]')?.textContent).toBe("$x^2$");
    expect(container.querySelector("pre")?.textContent).toContain("\\frac{a}{b}");
    expect(container.querySelector("math")).toBeNull();

    katex.release();
    await waitFor(() => {
      expect(container.querySelectorAll("math")).toHaveLength(2);
    });
    expect(container.querySelector('[data-math-state="pending"]')).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("loads KaTeX once however many formulas ask for it", async () => {
    const katex = mockKatex("hold");
    const container = await freshAnswer("A $a$, B $b$, C $c$.\n\n```math\nd\n```");
    katex.release();
    await waitFor(() => {
      expect(container.querySelectorAll("math")).toHaveLength(4);
    });
    expect(katex.imports()).toBe(1);
  });

  it("keeps the answer readable and reports a failed load once, without the formula", async () => {
    mockKatex("fail");
    const container = await freshAnswer(
      "Secret $x_secret$ and $y_secret$.\n\n```math\nz_secret\n```",
    );
    await waitFor(() => {
      expect(container.querySelectorAll('[data-math-state="unavailable"]')).toHaveLength(2);
    });
    expect(container.textContent).toContain("Secret $x_secret$ and $y_secret$.");
    expect(container.querySelector("pre")?.textContent).toContain("z_secret");
    expect(container.querySelector("math")).toBeNull();

    expect(diagnostics).toHaveLength(1);
    const [message, meta] = diagnostics[0] ?? ["", undefined];
    expect(message).toBe("Keiko math renderer unavailable.");
    expect(meta?.kind).toBe("other");
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
  });

  it("tries again on the next answer after a failed load", async () => {
    const failing = mockKatex("fail");
    const first = await freshAnswer("One $a$.");
    await waitFor(() => {
      expect(first.querySelector('[data-math-state="unavailable"]')).not.toBeNull();
    });
    expect(failing.imports()).toBe(1);

    // Same page, same loader module: only the stand-in for the chunk changes (it is reachable again).
    vi.doMock("katex", () => vi.importActual("katex"));
    const { SafeMarkdownBoundary } = await import("../../SafeMarkdown");
    const { CODING_WORKBENCH_RICH_CONTENT } = await import("./CodingWorkbenchRichContent");
    const second = render(
      <SafeMarkdownBoundary source={"Two $b$."} richContent={CODING_WORKBENCH_RICH_CONTENT} />,
    ).container;
    await waitFor(() => {
      expect(second.querySelector("math")).not.toBeNull();
    });
  });
});
