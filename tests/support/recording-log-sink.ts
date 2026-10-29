interface RecordingSink<Event> {
  readonly write: (event: Event) => void;
}

export function createFailingRecordingSink<Event extends { readonly op: string }>(
  failingOps: readonly string[],
  failure: () => Error,
): { sink: RecordingSink<Event>; events: Event[] } {
  const events: Event[] = [];
  return {
    sink: {
      write: (event): void => {
        if (failingOps.includes(event.op)) throw failure();
        events.push(event);
      },
    },
    events,
  };
}

export function createRecordingSink<Event extends { readonly op: string }>(): {
  readonly events: Event[];
  readonly sink: RecordingSink<Event>;
} {
  const events: Event[] = [];
  return {
    events,
    sink: {
      write(event: Event): void {
        events.push(event);
      },
    },
  };
}

export function recordingOps(events: readonly { readonly op: string }[]): readonly string[] {
  return events.map((event) => event.op);
}

export function recordingEventFor<Event extends { readonly op: string }>(
  events: readonly Event[],
  op: string,
): Event {
  const found = events.find((event) => event.op === op);
  if (found === undefined) {
    throw new Error(`expected an event with op '${op}', saw: ${recordingOps(events).join(", ")}`);
  }
  return found;
}
