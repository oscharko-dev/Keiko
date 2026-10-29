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
