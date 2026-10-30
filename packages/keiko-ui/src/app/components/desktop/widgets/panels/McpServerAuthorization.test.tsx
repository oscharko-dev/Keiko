import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { bffFetchJson } from "@/lib/http";
import { McpServerAuthorization } from "./McpServerAuthorization";
vi.mock("@/lib/http", () => ({ bffFetchJson: vi.fn() }));
const api = vi.mocked(bffFetchJson);
beforeEach(() => {
  api.mockReset();
});
function panel(authorized = false): ReturnType<typeof vi.fn> {
  const changed = vi.fn();
  render(
    <I18nProvider>
      <McpServerAuthorization name="synthetic" authorized={authorized} onChange={changed} />
    </I18nProvider>,
  );
  return changed;
}
it("opens the validated sign-in URL and observes completion without repeating the start", async () => {
  let finish: ((answer: unknown) => void) | undefined;
  api
    .mockResolvedValueOnce({
      outcome: "started",
      attemptId: "con_synthetic",
      authorizationUrl: "https://identity.example.test/authorize",
      expiresAtMs: Date.now() + 300_000,
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const changed = panel();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  const link = await screen.findByRole("link", { name: "Open sign-in page" });
  expect(link).toHaveAttribute("href", "https://identity.example.test/authorize");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await act(async () => {
    finish?.({ state: "complete" });
  });
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(api.mock.calls.filter(([path]) => path.endsWith("/authorization"))).toHaveLength(1);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("does not replay a failed authorization POST", async () => {
  api.mockRejectedValueOnce(new Error("synthetic transport failure"));
  const changed = panel();
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("alert");
  expect(api).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled();
});
it("revokes centrally and requests an authoritative refresh", async () => {
  api.mockResolvedValueOnce({ state: "revoked" });
  const changed = panel(true);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenCalledWith("/api/mcp/servers/synthetic/authorization/revoke", {
    method: "POST",
  });
});
