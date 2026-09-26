import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayConfigUpload } from "./GatewayConfigUpload";
import { MAX_GATEWAY_CONFIG_BYTES, parseGatewayConfigUpload } from "./gatewayConfigParsing";

// The default mock passes through to the real parser; tests that pin what the component does if
// a parser REGRESSION ever breaks the no-throw contract install a throwing implementation for
// exactly one call (review finding on #3031). The mock is the only way to produce the throw —
// the real parser's no-throw behavior is pinned by its own suite.
vi.mock("./gatewayConfigParsing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gatewayConfigParsing")>();
  return {
    ...actual,
    parseGatewayConfigUpload: vi.fn(actual.parseGatewayConfigUpload),
  };
});

describe("GatewayConfigUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a throwing parser as an invalid upload instead of crashing", async () => {
    vi.mocked(parseGatewayConfigUpload).mockImplementationOnce(() => {
      throw new Error("parser regression");
    });
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
      // The report is sanitized: no fragment of the uploaded file may reach the error channel.
      const reported = reportError.mock.calls[0]?.[0] as Error;
      expect(reported.message).toBe("gateway config upload: parser threw on an uploaded file");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a throwing apply callback sanitized and shows the invalid state", async () => {
    // The uploaded file carries a credential; the callback rethrows it the way an engine message
    // can embed excerpts of its input. NOTHING of either may reach the error channel.
    const secret = "sk-keiko-secret-never-in-diagnostics";
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    try {
      const onApply = vi.fn(() => {
        throw new Error(`gateway rejected key ${secret}`);
      });
      render(<GatewayConfigUpload disabled={false} onApply={onApply} />);

      await userEvent.upload(
        screen.getByLabelText(/load keiko\.config\.json/i),
        new File(
          [JSON.stringify({ providers: [{ modelId: "gpt-5o", apiKey: secret }] })],
          "keiko.config.json",
          { type: "application/json" },
        ),
      );

      // The REAL parser accepted the file and a "fields" outcome reached the callback …
      expect(await screen.findByRole("alert")).toHaveTextContent(
        /not a readable keiko configuration/i,
      );
      expect(onApply).toHaveBeenCalledOnce();
      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: secret, deploymentNames: ["gpt-5o"] }),
      );
      // … and the throw was reported sanitized: exact message, no file content, no success count.
      expect(reportError).toHaveBeenCalledOnce();
      const reported = reportError.mock.calls[0]?.[0] as Error;
      expect(reported.message).toBe("gateway config upload: apply callback threw");
      expect(String(reported)).not.toContain(secret);
      expect(screen.queryByText(/configuration loaded/i)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drives onReadPendingChange true before the file read and false after it", async () => {
    const onApply = vi.fn();
    const onReadPendingChange = vi.fn();
    const textSpy = vi.spyOn(Blob.prototype, "text");
    try {
      render(
        <GatewayConfigUpload
          disabled={false}
          onApply={onApply}
          onReadPendingChange={onReadPendingChange}
        />,
      );

      await userEvent.upload(
        screen.getByLabelText(/load keiko\.config\.json/i),
        new File([JSON.stringify({ providers: [{ modelId: "gpt-5o" }] })], "keiko.config.json", {
          type: "application/json",
        }),
      );

      await screen.findByText(/configuration loaded/i);
      // Exactly one pending window: true, then false — never a third transition.
      expect(onReadPendingChange.mock.calls).toEqual([[true], [false]]);
      expect(textSpy).toHaveBeenCalledOnce();
      // TRUE lands before the file read starts, FALSE only after it — the dialog must block
      // submission across the whole read (review finding on #3031).
      expect(onReadPendingChange.mock.invocationCallOrder[0]).toBeLessThan(
        textSpy.mock.invocationCallOrder[0] ?? 0,
      );
      expect(onReadPendingChange.mock.invocationCallOrder[1]).toBeGreaterThan(
        textSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      textSpy.mockRestore();
    }
  });

  it("refuses an oversized file before reading it and ends the pending flag false", async () => {
    const onApply = vi.fn();
    const onReadPendingChange = vi.fn();
    const textSpy = vi.spyOn(Blob.prototype, "text");
    try {
      render(
        <GatewayConfigUpload
          disabled={false}
          onApply={onApply}
          onReadPendingChange={onReadPendingChange}
        />,
      );

      await userEvent.upload(
        screen.getByLabelText(/load keiko\.config\.json/i),
        new File([new Uint8Array(MAX_GATEWAY_CONFIG_BYTES + 1)], "keiko.config.json", {
          type: "application/json",
        }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(/exceeds the supported 256/i);
      expect(onApply).not.toHaveBeenCalled();
      // The size gate fires on file.size BEFORE any read or parse (review finding on #3031).
      expect(textSpy).not.toHaveBeenCalled();
      expect(vi.mocked(parseGatewayConfigUpload)).not.toHaveBeenCalled();
      // The oversize path owns the pending flag — any older read is stale by token and must not
      // clear it, so this path must leave it false (review finding on #3031).
      expect(onReadPendingChange.mock.calls).toEqual([[false]]);
    } finally {
      textSpy.mockRestore();
    }
  });
});
