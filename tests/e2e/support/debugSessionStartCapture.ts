export interface CapturedDebugSessionEvent {
  readonly data: string;
  readonly event: string;
}

function startedSessionId(event: CapturedDebugSessionEvent): string | undefined {
  if (event.event !== "editor-debug:session-started") return undefined;
  try {
    const parsed = JSON.parse(event.data) as {
      readonly event?: { readonly sessionId?: unknown };
    };
    return typeof parsed.event?.sessionId === "string" ? parsed.event.sessionId : undefined;
  } catch {
    return undefined;
  }
}

export function capturedStartedSessionIds(
  events: readonly CapturedDebugSessionEvent[],
): readonly string[] {
  return events.flatMap((event) => {
    const sessionId = startedSessionId(event);
    return sessionId === undefined ? [] : [sessionId];
  });
}

export function capturedStartedSessionIdAfter(
  events: readonly CapturedDebugSessionEvent[],
  observedStartCount: number,
): string | undefined {
  return capturedStartedSessionIds(events)[observedStartCount];
}
