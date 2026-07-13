import {
  DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
  DEFAULT_DEBUG_PAYLOAD_LIMITS,
  type DebugEvent,
} from "@oscharko-dev/keiko-contracts";

export const DEBUG_EVENT_REPLAY_ENTRY_CAP = 2_000;
export const DEBUG_EVENT_REPLAY_BYTE_CAP = 512 * 1_024;
export const DEBUG_EVENT_SUBSCRIBER_CAP = 8;
export const DEBUG_EVENT_CHANNEL_CAP = 64;

export interface DebugEventChannel {
  readonly workspacePartitionKey: string;
  readonly browserSessionBinding: string;
}

export interface DebugEventEnvelope {
  readonly schemaVersion: typeof DAP_DEBUG_CONTRACT_SCHEMA_VERSION;
  readonly sequence: number;
  readonly event: DebugEvent;
}

export interface DebugEventReplaySnapshot {
  readonly sequence: number;
  readonly retainedCount: number;
  readonly retainedBytes: number;
  readonly evictedCount: number;
  readonly evictedBytes: number;
}

export type DebugEventSubscriptionResult =
  | {
      readonly kind: "ok";
      readonly replay: readonly DebugEventEnvelope[];
      readonly snapshot: DebugEventReplaySnapshot;
      readonly snapshotRequired: boolean;
      readonly unsubscribe: () => void;
    }
  | { readonly kind: "subscriberLimit"; readonly snapshot: DebugEventReplaySnapshot };

export interface DapEventBridge {
  publish(channel: DebugEventChannel, event: DebugEvent): boolean;
  subscribe(args: {
    readonly channel: DebugEventChannel;
    readonly lastSequence?: number | undefined;
    readonly onEvent: (event: DebugEventEnvelope) => void;
  }): DebugEventSubscriptionResult;
  snapshot(channel: DebugEventChannel): DebugEventReplaySnapshot;
  disposeChannel(channel: DebugEventChannel): void;
  disposeAll(): void;
}

interface RetainedEvent {
  readonly envelope: DebugEventEnvelope;
  readonly bytes: number;
}

interface ChannelState {
  readonly replay: RetainedEvent[];
  readonly subscribers: Map<number, (event: DebugEventEnvelope) => void>;
  sequence: number;
  replayBytes: number;
  evictedCount: number;
  evictedBytes: number;
  nextSubscriberId: number;
}

function channelKey(channel: DebugEventChannel): string {
  return `${channel.workspacePartitionKey}\u0000${channel.browserSessionBinding}`;
}

function createState(): ChannelState {
  return {
    replay: [],
    subscribers: new Map(),
    sequence: 0,
    replayBytes: 0,
    evictedCount: 0,
    evictedBytes: 0,
    nextSubscriberId: 0,
  };
}

function acquireState(channels: Map<string, ChannelState>, key: string): ChannelState | undefined {
  const existing = channels.get(key);
  if (existing !== undefined) return existing;
  if (channels.size >= DEBUG_EVENT_CHANNEL_CAP) {
    const idle = [...channels].find(([, state]) => state.subscribers.size === 0);
    if (idle === undefined) return undefined;
    channels.delete(idle[0]);
  }
  const created = createState();
  channels.set(key, created);
  return created;
}

function snapshot(state: ChannelState | undefined): DebugEventReplaySnapshot {
  if (state === undefined) {
    return Object.freeze({
      sequence: 0,
      retainedCount: 0,
      retainedBytes: 0,
      evictedCount: 0,
      evictedBytes: 0,
    });
  }
  return Object.freeze({
    sequence: state.sequence,
    retainedCount: state.replay.length,
    retainedBytes: state.replayBytes,
    evictedCount: state.evictedCount,
    evictedBytes: state.evictedBytes,
  });
}

function eventBytes(envelope: DebugEventEnvelope): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

function evictToBounds(state: ChannelState): void {
  while (
    state.replay.length > DEBUG_EVENT_REPLAY_ENTRY_CAP ||
    state.replayBytes > DEBUG_EVENT_REPLAY_BYTE_CAP
  ) {
    const evicted = state.replay.shift();
    if (evicted === undefined) return;
    state.replayBytes -= evicted.bytes;
    state.evictedCount += 1;
    state.evictedBytes += evicted.bytes;
  }
}

function replayAfter(
  state: ChannelState,
  lastSequence: number | undefined,
): { readonly replay: readonly DebugEventEnvelope[]; readonly snapshotRequired: boolean } {
  if (lastSequence === undefined)
    return { replay: state.replay.map((entry) => entry.envelope), snapshotRequired: false };
  if (lastSequence > state.sequence) return { replay: [], snapshotRequired: true };
  const oldest = state.replay[0]?.envelope.sequence ?? state.sequence + 1;
  if (lastSequence < oldest - 1) return { replay: [], snapshotRequired: true };
  return {
    replay: state.replay
      .filter((entry) => entry.envelope.sequence > lastSequence)
      .map((entry) => entry.envelope),
    snapshotRequired: false,
  };
}

function publish(state: ChannelState, event: DebugEvent): boolean {
  const envelope = eventEnvelope(state.sequence + 1, event);
  const bytes = eventBytes(envelope);
  const retained =
    bytes <= DEFAULT_DEBUG_PAYLOAD_LIMITS.maxSseEventBytes
      ? { envelope, bytes }
      : truncatedEnvelope(state.sequence + 1, bytes);
  state.sequence = retained.envelope.sequence;
  state.replay.push(retained);
  state.replayBytes += retained.bytes;
  if (event.kind === "session-stopped") retainTerminalOnly(state, retained);
  evictToBounds(state);
  for (const subscriber of state.subscribers.values()) subscriber(retained.envelope);
  return true;
}

function retainTerminalOnly(state: ChannelState, terminal: RetainedEvent): void {
  for (const retained of state.replay) {
    if (retained !== terminal) {
      state.evictedCount += 1;
      state.evictedBytes += retained.bytes;
    }
  }
  state.replay.splice(0, state.replay.length, terminal);
  state.replayBytes = terminal.bytes;
}

function eventEnvelope(sequence: number, event: DebugEvent): DebugEventEnvelope {
  const frozenEvent: DebugEvent = Object.freeze({ ...event });
  return Object.freeze({
    schemaVersion: DAP_DEBUG_CONTRACT_SCHEMA_VERSION,
    sequence,
    event: frozenEvent,
  });
}

function truncatedEnvelope(sequence: number, originalBytes: number): RetainedEvent {
  const envelope = eventEnvelope(sequence, {
    kind: "projection-truncated",
    reason: "sse-event-size",
    originalBytes,
  });
  return { envelope, bytes: eventBytes(envelope) };
}

export function createDapEventBridge(): DapEventBridge {
  const channels = new Map<string, ChannelState>();
  return {
    publish: (channel, event): boolean => {
      const key = channelKey(channel);
      const state = acquireState(channels, key);
      if (state === undefined) return false;
      return publish(state, event);
    },
    subscribe: ({ channel, lastSequence, onEvent }): DebugEventSubscriptionResult => {
      const key = channelKey(channel);
      const state = acquireState(channels, key);
      if (state === undefined) {
        return { kind: "subscriberLimit", snapshot: snapshot(undefined) };
      }
      if (state.subscribers.size >= DEBUG_EVENT_SUBSCRIBER_CAP) {
        return { kind: "subscriberLimit", snapshot: snapshot(state) };
      }
      const subscriberId = state.nextSubscriberId++;
      state.subscribers.set(subscriberId, onEvent);
      const replay = replayAfter(state, lastSequence);
      return {
        kind: "ok",
        replay: replay.replay,
        snapshot: snapshot(state),
        snapshotRequired: replay.snapshotRequired,
        unsubscribe: (): void => void state.subscribers.delete(subscriberId),
      };
    },
    snapshot: (channel) => snapshot(channels.get(channelKey(channel))),
    disposeChannel: (channel): void => {
      channels.delete(channelKey(channel));
    },
    disposeAll: (): void => {
      channels.clear();
    },
  };
}
