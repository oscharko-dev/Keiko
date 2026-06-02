import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { setupGateway } from "@/lib/api";
import { GatewaySetupDialog } from "./GatewaySetupDialog";

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

describe("GatewaySetupDialog", () => {
  it("requires real deployment names for Azure AI Foundry before testing credentials", async () => {
    render(<GatewaySetupDialog />);

    expect(screen.getByLabelText(/deployment names for azure/i)).toHaveAttribute(
      "placeholder",
      "Paste deployment names, one per line",
    );
    expect(screen.queryByPlaceholderText("phi-4")).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText(/base url/i),
      "https://workspace.example.services.ai.azure.com/openai/v1",
    );
    await userEvent.type(screen.getByLabelText(/api token/i), "example-token");
    await userEvent.click(screen.getByRole("button", { name: /test & save/i }));

    expect(screen.getByText(/azure ai foundry requires deployment names/i)).toBeInTheDocument();
    expect(setupGateway).not.toHaveBeenCalled();
  });
});
