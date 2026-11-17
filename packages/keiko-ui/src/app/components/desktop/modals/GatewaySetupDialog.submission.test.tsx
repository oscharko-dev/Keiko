import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, setupGateway, type GatewaySetupResponse } from "@/lib/api";
import { GatewaySetupDialog } from "./GatewaySetupDialog";
import { GATEWAY_CONFIG_UPDATED_EVENT } from "../widgets/shared/gatewaySetupBus";

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  setupGateway: vi.fn(),
}));

const SUCCESS: GatewaySetupResponse = {
  ok: true,
  testedModelId: "synthetic-chat",
  testedModelIds: ["synthetic-chat"],
  providerCount: 1,
  models: [],
  config: {
    providers: [],
    circuitBreaker: { failureThreshold: 5, cooldownMs: 30_000, halfOpenProbes: 2 },
  },
};
const SYNTHETIC_TOKEN = "synthetic-gateway-token";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fillCredentials(): void {
  fireEvent.change(screen.getByLabelText(/^base url/i), {
    target: { value: "https://gateway.example.test/v1" },
  });
  fireEvent.change(screen.getByLabelText(/^api token/i), {
    target: { value: SYNTHETIC_TOKEN },
  });
}

describe("GatewaySetupDialog explicit submission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(setupGateway).mockReset();
  });

  it.each([false, true])(
    "keeps the token masked without an HTML form or submit button (update=%s)",
    (preserveExisting) => {
      render(<GatewaySetupDialog preserveExisting={preserveExisting} />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.querySelector("form")).toBeNull();
      expect(screen.getByRole("button", { name: /test & save/i })).toHaveAttribute(
        "type",
        "button",
      );
      expect(screen.getByLabelText(/^api token/i)).toHaveAttribute("type", "password");
      expect(screen.getByLabelText(/^api token/i)).toHaveAttribute("autocomplete", "off");
    },
  );

  it.each([/^base url/i, /^api token/i])(
    "rejects Enter while the required %s field is missing",
    (missingField) => {
      render(<GatewaySetupDialog />);
      fillCredentials();
      fireEvent.change(screen.getByLabelText(missingField), { target: { value: " " } });
      fireEvent.keyDown(screen.getByLabelText(/^api token/i), { key: "Enter" });
      expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();
      expect(setupGateway).not.toHaveBeenCalled();
    },
  );

  it.each(["Enter", "click"] as const)(
    "submits once by %s, retains the pending token and clears it only after success",
    async (action) => {
      const response = deferred<GatewaySetupResponse>();
      vi.mocked(setupGateway).mockReturnValue(response.promise);
      const user = userEvent.setup();
      render(<GatewaySetupDialog />);
      fillCredentials();
      const token = screen.getByLabelText(/^api token/i);
      if (action === "Enter") {
        token.focus();
        await user.keyboard("{Enter}");
      } else {
        await user.click(screen.getByRole("button", { name: /test & save/i }));
      }
      expect(setupGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ apiKey: SYNTHETIC_TOKEN, preserveExisting: false }),
      );
      expect(token).toHaveValue(SYNTHETIC_TOKEN);
      expect(screen.getByRole("dialog")).toHaveFocus();
      expect(screen.getByRole("button", { name: /testing credentials/i })).toBeDisabled();
      fireEvent.keyDown(token, { key: "Enter" });
      expect(setupGateway).toHaveBeenCalledOnce();
      await act(async () => response.resolve(SUCCESS));
      expect(token).toHaveValue("");
      expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();
    },
  );

  it("keeps token-only rotation available through Enter with the stored URL unchanged", async () => {
    vi.mocked(setupGateway).mockResolvedValue(SUCCESS);
    const user = userEvent.setup();
    render(<GatewaySetupDialog preserveExisting />);
    await user.click(screen.getByText(/replace model gateway settings/i));
    const token = screen.getByLabelText(/^api token/i);
    fireEvent.change(token, { target: { value: SYNTHETIC_TOKEN } });
    token.focus();
    await user.keyboard("{Enter}");
    expect(setupGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ apiKey: SYNTHETIC_TOKEN, preserveExisting: true }),
    );
    expect(vi.mocked(setupGateway).mock.calls[0]?.[0].baseUrl).toBeUndefined();
    expect(token).toHaveValue("");
  });

  it("leaves Enter during IME composition unhandled", () => {
    render(<GatewaySetupDialog />);
    fillCredentials();
    const token = screen.getByLabelText(/^api token/i);
    const event = createEvent.keyDown(token, { key: "Enter", isComposing: true });
    fireEvent(token, event);
    expect(event.defaultPrevented).toBe(false);
    expect(setupGateway).not.toHaveBeenCalled();
  });

  it("leaves Enter immediately after compositionend unhandled and accepts the next Enter", () => {
    vi.useFakeTimers();
    const response = deferred<GatewaySetupResponse>();
    vi.mocked(setupGateway).mockReturnValue(response.promise);
    try {
      render(<GatewaySetupDialog />);
      fillCredentials();
      const token = screen.getByLabelText(/^api token/i);
      fireEvent.compositionEnd(token, { data: "候補" });
      const event = createEvent.keyDown(token, { key: "Enter", isComposing: false });
      fireEvent(token, event);
      expect(event.defaultPrevented).toBe(false);
      expect(setupGateway).not.toHaveBeenCalled();
      act(() => vi.advanceTimersToNextFrame());
      fireEvent.keyDown(token, { key: "Enter" });
      expect(setupGateway).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an already handled Enter and ordinary text keys unhandled", () => {
    render(<GatewaySetupDialog />);
    fillCredentials();
    const token = screen.getByLabelText(/^api token/i);
    const event = createEvent.keyDown(token, { key: "Enter" });
    event.preventDefault();
    fireEvent(token, event);
    expect(fireEvent.keyDown(token, { key: "a" })).toBe(true);
    expect(setupGateway).not.toHaveBeenCalled();
  });

  it("preserves textarea newlines, select confirmation and the file input's Enter", async () => {
    const user = userEvent.setup();
    render(<GatewaySetupDialog />);
    fillCredentials();
    const names = screen.getByLabelText(/deployment names/i);
    await user.click(names);
    await user.keyboard("first{Enter}second");
    expect(names).toHaveValue("first\nsecond");
    const protocol = screen.getByRole("combobox", { name: /gateway endpoint style/i });
    await user.click(protocol);
    await user.click(screen.getByRole("option", { name: "OpenAI-compatible" }));
    await user.click(protocol);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(protocol).toHaveTextContent("Azure deployment path");
    const upload = await screen.findByLabelText(/load keiko\.config\.json/i);
    expect(fireEvent.keyDown(upload, { key: "Enter" })).toBe(true);
    expect(setupGateway).not.toHaveBeenCalled();
  });

  it("leaves Enter to controls portalled into the dialog outside its settings fields", () => {
    render(<GatewaySetupDialog />);
    fillCredentials();
    render(
      createPortal(
        <input type="search" aria-label="Synthetic portalled search" />,
        screen.getByRole("dialog"),
      ),
    );
    expect(fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" })).toBe(true);
    expect(setupGateway).not.toHaveBeenCalled();
  });

  it("blocks Enter throughout a real configuration file read, then admits the ready fields", async () => {
    const read = deferred<string>();
    vi.spyOn(Blob.prototype, "text").mockReturnValueOnce(read.promise);
    vi.mocked(setupGateway).mockResolvedValue(SUCCESS);
    const user = userEvent.setup();
    render(<GatewaySetupDialog />);
    fillCredentials();
    await user.upload(
      await screen.findByLabelText(/load keiko\.config\.json/i),
      new File(["not-json"], "keiko.config.json", { type: "application/json" }),
    );
    const token = screen.getByLabelText(/^api token/i);
    expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();
    fireEvent.keyDown(token, { key: "Enter" });
    expect(setupGateway).not.toHaveBeenCalled();
    expect(token).toHaveValue(SYNTHETIC_TOKEN);
    await act(async () => read.resolve("not-json"));
    expect(screen.getByRole("button", { name: /test & save/i })).toBeEnabled();
    fireEvent.keyDown(token, { key: "Enter" });
    await waitFor(() => expect(setupGateway).toHaveBeenCalledOnce());
    await waitFor(() => expect(token).toHaveValue(""));
  });

  it("retains the token after an API failure and clears it on a successful correction", async () => {
    vi.mocked(setupGateway)
      .mockRejectedValueOnce(new ApiError("GATEWAY_ERROR", "Synthetic gateway refused", 503))
      .mockResolvedValueOnce(SUCCESS);
    const listener = vi.fn();
    window.addEventListener(GATEWAY_CONFIG_UPDATED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(<GatewaySetupDialog />);
      fillCredentials();
      const token = screen.getByLabelText(/^api token/i);
      await user.click(screen.getByRole("button", { name: /test & save/i }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic gateway refused");
      expect(token).toHaveValue(SYNTHETIC_TOKEN);
      expect(screen.getByLabelText(/^base url/i)).toHaveFocus();
      expect(listener).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByLabelText(/^base url/i), { key: "Enter" });
      await waitFor(() => expect(token).toHaveValue(""));
      expect(listener).toHaveBeenCalledOnce();
      expect(setupGateway).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(GATEWAY_CONFIG_UPDATED_EVENT, listener);
    }
  });

  it("retains the token after local validation refuses a non-integer timeout", async () => {
    render(<GatewaySetupDialog />);
    fillCredentials();
    fireEvent.change(screen.getByLabelText(/request timeout.*optional/i), {
      target: { value: "12.5" },
    });
    fireEvent.keyDown(screen.getByLabelText(/^api token/i), { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /request timeout must be a positive integer/i,
    );
    expect(screen.getByLabelText(/^api token/i)).toHaveValue(SYNTHETIC_TOKEN);
    expect(setupGateway).not.toHaveBeenCalled();
  });

  it("refuses late Enter after success even if the token input is repopulated", async () => {
    vi.mocked(setupGateway).mockResolvedValue(SUCCESS);
    const user = userEvent.setup();
    render(<GatewaySetupDialog />);
    fillCredentials();
    await user.click(screen.getByRole("button", { name: /test & save/i }));
    const token = screen.getByLabelText(/^api token/i);
    await waitFor(() => expect(token).toHaveValue(""));
    fireEvent.change(token, { target: { value: "synthetic-repopulated-token" } });
    fireEvent.keyDown(token, { key: "Enter" });
    expect(setupGateway).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /test & save/i })).toBeDisabled();
  });
});
