import { expect, it } from "vitest";
import {
  activityLogLossCounters,
  resetActivityLogLossCountersForTests,
} from "@oscharko-dev/keiko-contracts/runtime/observability";

interface LogPortSink<Event> {
  readonly write: (event: Event) => void;
}

type PortWrite<Event, Sink> = (this: Sink, received: Event) => void;

interface SynchronousLogDeliveryBinding<
  Event extends { readonly op: string },
  Sink extends LogPortSink<Event>,
  Op extends Event["op"],
> {
  readonly emit: (sink: Sink | undefined, event: Event) => void;
  readonly makeSink: (readWrite: (receiver: Sink) => PortWrite<Event, Sink>) => Sink;
  readonly unreadOperationEvent: (readOp: () => never) => Event;
  readonly countedOperationEvent: (readOp: () => Op) => Event;
  readonly droppedOp: Op;
  readonly noticeOp: Event["op"];
}

function defineUnwiredDelivery<
  Event extends { readonly op: string },
  Sink extends LogPortSink<Event>,
  Op extends Event["op"],
>(binding: SynchronousLogDeliveryBinding<Event, Sink, Op>): void {
  it("counts an unwired event without observing its operation", () => {
    resetActivityLogLossCountersForTests();
    try {
      const event = binding.unreadOperationEvent((): never => {
        throw new TypeError("unwired event must remain unread");
      });
      const emit = binding.emit;
      emit(undefined, event);
      expect(activityLogLossCounters()["port-unwired"]).toBe(1);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
}

function defineHealthyDelivery<
  Event extends { readonly op: string },
  Sink extends LogPortSink<Event>,
  Op extends Event["op"],
>(binding: SynchronousLogDeliveryBinding<Event, Sink, Op>): void {
  it("reads the write method once and preserves its receiver and exact event", () => {
    resetActivityLogLossCountersForTests();
    try {
      let getterReads = 0;
      let writes = 0;
      const event = binding.unreadOperationEvent((): never => {
        throw new TypeError("healthy delivery must not inspect the event");
      });
      const sink = binding.makeSink((receiver): PortWrite<Event, Sink> => {
        getterReads += 1;
        expect(receiver).toBe(sink);
        return function (this: Sink, received: Event): void {
          expect(this).toBe(sink);
          expect(received).toBe(event);
          writes += 1;
        };
      });
      const emit = binding.emit;
      emit(sink, event);
      expect(getterReads).toBe(1);
      expect(writes).toBe(1);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(0);
      expect(activityLogLossCounters()["port-unwired"]).toBe(0);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
}

function defineGetterFailure<
  Event extends { readonly op: string },
  Sink extends LogPortSink<Event>,
  Op extends Event["op"],
>(binding: SynchronousLogDeliveryBinding<Event, Sink, Op>): void {
  it("counts a getter failure before operation and cause inspection", () => {
    resetActivityLogLossCountersForTests();
    try {
      const trace: string[] = [];
      const failure = new Error("opaque primary transport failure");
      Object.defineProperty(failure, "code", {
        get(this: Error): string {
          expect(this).toBe(failure);
          trace.push(`cause-code:${activityLogLossCounters()["port-sink-failed"].toString()}`);
          return "ENOSPC";
        },
      });
      const event = binding.countedOperationEvent((): Op => {
        trace.push(`op:${activityLogLossCounters()["port-sink-failed"].toString()}`);
        return binding.droppedOp;
      });
      const notices: Event[] = [];
      let getterReads = 0;
      const sink = binding.makeSink((): PortWrite<Event, Sink> => {
        trace.push("write-get");
        getterReads += 1;
        if (getterReads === 1) throw failure;
        return (received): void => {
          trace.push("notice-write");
          notices.push(received);
        };
      });
      const emit = binding.emit;
      emit(sink, event);
      expect(trace).toEqual(["write-get", "op:1", "cause-code:1", "write-get", "notice-write"]);
      expect(notices.map((notice) => notice.op)).toEqual([binding.noticeOp]);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
}

function defineOperationFailure<
  Event extends { readonly op: string },
  Sink extends LogPortSink<Event>,
  Op extends Event["op"],
>(binding: SynchronousLogDeliveryBinding<Event, Sink, Op>): void {
  it("preserves an operation-getter failure escaping the owning continuation", () => {
    resetActivityLogLossCountersForTests();
    try {
      const failure = new TypeError("opaque failed-event operation");
      const event = binding.unreadOperationEvent((): never => {
        expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
        throw failure;
      });
      let getterReads = 0;
      const sink = binding.makeSink((): PortWrite<Event, Sink> => {
        getterReads += 1;
        throw new TypeError("primary write getter failed");
      });
      let observed: unknown;
      const emit = binding.emit;
      try {
        emit(sink, event);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBe(failure);
      expect(getterReads).toBe(1);
      expect(activityLogLossCounters()["port-sink-failed"]).toBe(1);
    } finally {
      resetActivityLogLossCountersForTests();
    }
  });
}

export function defineSynchronousLogDeliveryContract<
  Event extends { readonly op: string },
  Sink extends LogPortSink<Event>,
  Op extends Event["op"],
>(binding: SynchronousLogDeliveryBinding<Event, Sink, Op>): void {
  defineUnwiredDelivery(binding);
  defineHealthyDelivery(binding);
  defineGetterFailure(binding);
  defineOperationFailure(binding);
}
