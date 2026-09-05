import type {
  ToolInvocationBudgetPort,
  ToolInvocationBudgetReservation,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-bridge";
import type { ToolDescriptor } from "@oscharko-dev/keiko-contracts/runtime/governed-tool-catalog";
import {
  captureToolInvocationReceipt,
  type ToolInvocationReceipt,
} from "@oscharko-dev/keiko-contracts/runtime/governed-tool-lifecycle";
import { verifyToolDescriptor } from "@oscharko-dev/keiko-tool-catalog";
import type { HarnessLimits, RunCounters } from "./types.js";

export interface HarnessBudgetContext {
  readonly runId: string;
  readonly signal: AbortSignal;
}
export interface HarnessCatalogBudget {
  readonly port: ToolInvocationBudgetPort<HarnessBudgetContext>;
  readonly acceptReceipt: (receipt: ToolInvocationReceipt, descriptor: ToolDescriptor) => void;
}
interface Charge {
  readonly reservation: ToolInvocationBudgetReservation;
  readonly descriptorDigest: string;
  readonly command: boolean;
  state: "reserved" | "committed" | "released";
}
interface BudgetOwner {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly counters: RunCounters;
  readonly limits: HarnessLimits;
  readonly now: () => number;
  readonly deadlineAt: number;
}
export function descriptorRunsCommand(descriptor: ToolDescriptor): boolean {
  return verifyToolDescriptor(descriptor).effects.includes("command-execution");
}

/** Reservations charge the existing counters atomically; only pre-effect release refunds them. */
class HarnessCounterBudget implements HarnessCatalogBudget {
  private readonly charges = new Map<string, Charge>();
  private failed = false;
  private lastNow = 0;
  constructor(private readonly owner: BudgetOwner) {
    this.clockLive();
  }
  private clockLive(): boolean {
    if (this.failed) return false;
    const now = this.owner.now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.lastNow ||
      !Number.isSafeInteger(this.owner.deadlineAt) ||
      now >= this.owner.deadlineAt
    ) {
      this.failed = true;
      return false;
    }
    this.lastNow = now;
    return true;
  }
  readonly port: ToolInvocationBudgetPort<HarnessBudgetContext> = {
    available: (descriptor, context): boolean => this.available(descriptor, context),
    reserve: (descriptor, context, invocationId): ToolInvocationBudgetReservation | undefined =>
      this.reserve(descriptor, context, invocationId),
    check: (reservation, context): boolean => this.check(reservation, context),
    commit: (reservation): void => {
      this.settle(reservation, "committed");
    },
    release: (reservation): void => {
      this.settle(reservation, "released");
    },
  };
  private live(context: HarnessBudgetContext): boolean {
    return (
      this.clockLive() &&
      !this.owner.signal.aborted &&
      !context.signal.aborted &&
      context.runId === this.owner.runId
    );
  }
  private available(descriptor: ToolDescriptor, context: HarnessBudgetContext): boolean {
    return (
      this.live(context) &&
      this.owner.counters.toolCalls < this.owner.limits.maxToolCalls &&
      (!descriptorRunsCommand(descriptor) ||
        this.owner.counters.commandExecutions < this.owner.limits.maxCommandExecutions)
    );
  }
  private reserve(
    descriptor: ToolDescriptor,
    context: HarnessBudgetContext,
    invocationId: string,
  ): ToolInvocationBudgetReservation | undefined {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(invocationId) ||
      !this.available(descriptor, context) ||
      this.charges.has(invocationId) ||
      this.charges.size >= this.owner.limits.maxToolCalls
    )
      return undefined;
    const verified = verifyToolDescriptor(descriptor);
    const reservation = Object.freeze({ reservationId: invocationId });
    const command = descriptorRunsCommand(verified);
    this.owner.counters.toolCalls += 1;
    if (command) this.owner.counters.commandExecutions += 1;
    this.charges.set(invocationId, {
      reservation,
      command,
      descriptorDigest: verified.descriptorDigest,
      state: "reserved",
    });
    return reservation;
  }
  private check(
    reservation: ToolInvocationBudgetReservation,
    context: HarnessBudgetContext,
  ): boolean {
    const charge = this.charges.get(reservation.reservationId);
    return (
      this.live(context) &&
      charge?.state === "reserved" &&
      this.owner.counters.toolCalls <= this.owner.limits.maxToolCalls &&
      (!charge.command ||
        this.owner.counters.commandExecutions <= this.owner.limits.maxCommandExecutions)
    );
  }
  private settle(
    reservation: ToolInvocationBudgetReservation,
    state: "committed" | "released",
  ): void {
    const charge = this.charges.get(reservation.reservationId);
    if (charge?.state !== "reserved") throw new TypeError("Invalid harness budget settlement");
    charge.state = state;
    if (state === "released") {
      this.owner.counters.toolCalls -= 1;
      if (charge.command) this.owner.counters.commandExecutions -= 1;
    }
  }
  readonly acceptReceipt = (receipt: ToolInvocationReceipt, descriptor: ToolDescriptor): void => {
    try {
      acceptReceipt(this.charges, receipt, descriptor);
    } catch (cause) {
      this.failed = true;
      throw cause;
    }
  };
}
export function createHarnessCatalogBudget(owner: BudgetOwner): HarnessCatalogBudget {
  return new HarnessCounterBudget(owner);
}

function acceptReceipt(
  charges: Map<string, Charge>,
  input: ToolInvocationReceipt,
  descriptor: ToolDescriptor,
): void {
  const receipt = captureToolInvocationReceipt(input);
  if (receipt.budgetDisposition === "not-reserved") {
    if (receipt.status === "completed" || charges.has(receipt.invocationId))
      throw new TypeError("Unacknowledged harness budget reservation");
    return;
  }
  const charge = charges.get(receipt.invocationId);
  // Compares against `charge` explicitly instead of `charge?.reservation...` (sonarjs
  // different-types-comparison): the reservation's `reservationId` is always a `string`, while a
  // missing charge previously surfaced as `undefined` compared against the receipt's
  // `string | null` field. No charge for this invocationId is itself a mismatch.
  if (
    charge === undefined ||
    charge.reservation.reservationId !== receipt.reservationId ||
    charge.descriptorDigest !== verifyToolDescriptor(descriptor).descriptorDigest ||
    charge.state !== receipt.budgetDisposition
  )
    throw new TypeError("Uncertain or mismatched harness budget settlement");
  charges.delete(receipt.invocationId);
}
