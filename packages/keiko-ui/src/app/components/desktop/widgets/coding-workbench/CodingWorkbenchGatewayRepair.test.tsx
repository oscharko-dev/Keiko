import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";
import type { CodingWorkbenchGatewayServiceRepairOutcome } from "@oscharko-dev/keiko-contracts";

import { CodingWorkbenchGatewayRepair } from "./CodingWorkbenchGatewayRepair";
import { EN_CODING_WORKBENCH_MESSAGES } from "./coding-workbench-i18n.en";

function repairReturning(
  outcome: CodingWorkbenchGatewayServiceRepairOutcome,
): ReturnType<
  typeof vi.fn<() => Promise<{ outcome: CodingWorkbenchGatewayServiceRepairOutcome }>>
> {
  return vi.fn(() => Promise.resolve({ outcome }));
}

describe("CodingWorkbenchGatewayRepair", () => {
  it.each([
    "gateway-service-unqualified",
    "gateway-service-managed-outside",
    "platform-unqualified",
    undefined,
  ])("offers no Repair for %s", (reason) => {
    const { container } = render(
      <CodingWorkbenchGatewayRepair
        reason={reason}
        onRepaired={() => Promise.resolve()}
        repair={repairReturning("ready")}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("replaces the terminal command with one Repair action and reads readiness again", async () => {
    const repair = repairReturning("ready");
    const onRepaired = vi.fn(() => Promise.resolve());
    const { container } = render(
      <CodingWorkbenchGatewayRepair
        reason="gateway-service-stale"
        onRepaired={onRepaired}
        repair={repair}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.click(screen.getByRole("button", { name: "Repair" }));

    expect(repair).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        EN_CODING_WORKBENCH_MESSAGES["codingWorkbench.gatewayService.repairReady"],
      ),
    ).toBeVisible();
    expect(onRepaired).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["declined", "codingWorkbench.gatewayService.repairDeclined"],
    ["failed", "codingWorkbench.gatewayService.repairFailed"],
    ["busy", "codingWorkbench.gatewayService.repairBusy"],
    ["unavailable", "codingWorkbench.gatewayService.repairUnavailable"],
  ] as const)("names the %s outcome in plain words", async (outcome, key) => {
    render(
      <CodingWorkbenchGatewayRepair
        reason="gateway-service-absent"
        onRepaired={() => Promise.resolve()}
        repair={repairReturning(outcome)}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(await screen.findByText(EN_CODING_WORKBENCH_MESSAGES[key])).toBeVisible();
  });

  it("reports a request that did not reach the server as a failed repair", async () => {
    render(
      <CodingWorkbenchGatewayRepair
        reason="gateway-service-absent"
        onRepaired={() => Promise.resolve()}
        repair={() => Promise.reject(new Error("offline"))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Repair" }));
    expect(
      await screen.findByText(
        EN_CODING_WORKBENCH_MESSAGES["codingWorkbench.gatewayService.repairFailed"],
      ),
    ).toBeVisible();
  });

  it("never names a terminal command for a repairable gateway", () => {
    for (const key of [
      "codingWorkbench.gatewayService.absent",
      "codingWorkbench.gatewayService.stopped",
      "codingWorkbench.gatewayService.stale",
      "codingWorkbench.gatewayService.unknown",
    ] as const) {
      expect(EN_CODING_WORKBENCH_MESSAGES[key]).not.toContain("keiko gateway-service");
      expect(EN_CODING_WORKBENCH_MESSAGES[key]).toContain("Repair");
    }
  });
});
