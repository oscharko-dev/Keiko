import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { GatewayConfigUpload } from "./GatewayConfigUpload";
import { MAX_GATEWAY_CONFIG_BYTES } from "./gatewayConfigParsing";

// The parser is written to never throw on hostile input; this file pins what the component does
// if a parser REGRESSION ever breaks that contract (review finding on #3031). The mock is the
// only way to produce the throw — the real parser's no-throw behavior is pinned by its own suite.
vi.mock("./gatewayConfigParsing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gatewayConfigParsing")>();
  return {
    ...actual,
    parseGatewayConfigUpload: vi.fn(() => {
      throw new Error("parser regression");
    }),
  };
});

describe("GatewayConfigUpload", () => {
  it("reports a throwing parser as an invalid upload instead of crashing", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    try {
      const onApply = vi.fn();
      render(<GatewayConfigUpload disabled={false} onApply={onApply} />);

      await userEvent.upload(
        screen.getByLabelText(/load keiko\.config\.json/i),
        new File(["{}"], "keiko.config.json", { type: "application/json" }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /not a readable keiko configuration/i,
      );
      expect(onApply).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses an oversized file before reading it", async () => {
    // The size gate fires on file.size BEFORE any read — the throwing mocked parser above
    // doubles as proof that the oversized path never reaches parsing (review finding on #3031).
    const onApply = vi.fn();
    render(<GatewayConfigUpload disabled={false} onApply={onApply} />);

    await userEvent.upload(
      screen.getByLabelText(/load keiko\.config\.json/i),
      new File([new Uint8Array(MAX_GATEWAY_CONFIG_BYTES + 1)], "keiko.config.json", {
        type: "application/json",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/exceeds the supported 256/i);
    expect(onApply).not.toHaveBeenCalled();
  });
});
