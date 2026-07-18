import { describe, expect, it, vi } from "vitest";

import {
  CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS,
  type CodingAppSessionChannelContent,
} from "./channelContract.js";
import { createFakeSessionPairingPort, fakePairingRequestBody } from "./_support.js";
import {
  CODING_APP_SESSION_MAX_LIVE_STREAMS,
  createCodingAppSessionChannel,
  type CodingAppSessionContentSource,
} from "./sessionChannel.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { createCodingSafeActivityProjection } from "../coding-runtime/codingSafeActivityProjection.js";

const CANARY: CodingAppSessionChannelContent = {
  kind: "probe",
  body: "bounded-canary-payload",
};

function liveSource(initial = CANARY): {
  readonly source: CodingAppSessionContentSource;
  readonly emit: (content: CodingAppSessionChannelContent | null) => void;
  readonly subscribers: () => number;
} {
  let current: CodingAppSessionChannelContent | null = initial;
  const listeners = new Set<(content: CodingAppSessionChannelContent | null) => void>();
  return {
    source: {
      contentFor: () => current,
      subscribeContent: (listener): { readonly admitted: boolean; readonly detach: () => void } => {
        listeners.add(listener);
        return { admitted: true, detach: (): void => void listeners.delete(listener) };
      },
    },
    emit: (content): void => {
      current = content;
      for (const listener of listeners) listener(content);
    },
    subscribers: (): number => listeners.size,
  };
}

function pairedChannel(contentSource?: CodingAppSessionContentSource): {
  readonly channel: ReturnType<typeof createCodingAppSessionChannel>;
  readonly cookieToken: string;
} {
  const channel = createCodingAppSessionChannel({
    registry: createSessionRegistry(),
    pairingPort: createFakeSessionPairingPort(),
    ...(contentSource ? { contentSource } : {}),
  });
  const result = channel.pair(fakePairingRequestBody());
  if (!result.paired) throw new Error("expected pairing to succeed");
  return { channel, cookieToken: result.cookieToken };
}

describe("createCodingAppSessionChannel", () => {
  it("cannot pair without a pairing authority (fail closed)", () => {
    const channel = createCodingAppSessionChannel({ registry: createSessionRegistry() });
    expect(channel.pair(fakePairingRequestBody())).toEqual({ paired: false });
    expect(channel.sessionCount()).toBe(0);
  });

  it("does not pair when the authority denies a well-formed attestation", () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort({ shouldApprove: () => false }),
    });
    expect(channel.pair(fakePairingRequestBody())).toEqual({ paired: false });
    expect(channel.sessionCount()).toBe(0);
  });

  it("denies a malformed attestation even with an authority present", () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    expect(channel.pair({ requestId: "bad id!", issuedAtMs: -1, claim: "" })).toEqual({
      paired: false,
    });
  });

  it("serves content-free to an unpaired reader", () => {
    const { channel } = pairedChannel(createStatic(CANARY));
    expect(channel.snapshot(undefined).content).toBeNull();
    expect(channel.snapshot("sess_deadbeefdeadbeefdeadbeef.forged").content).toBeNull();
  });

  it("serves content-free to a paired reader when no content source is wired", () => {
    const { channel, cookieToken } = pairedChannel();
    expect(channel.snapshot(cookieToken).content).toBeNull();
  });

  it("serves the bounded payload to a paired reader with a content source", () => {
    const { channel, cookieToken } = pairedChannel(createStatic(CANARY));
    expect(channel.snapshot(cookieToken).content).toEqual(CANARY);
  });

  it("fails closed to content-free when the content source exceeds the bound", () => {
    const oversize = {
      kind: "probe",
      body: "x".repeat(CODING_APP_SESSION_CHANNEL_BODY_MAX_CHARS + 1),
    };
    const { channel, cookieToken } = pairedChannel(createStatic(oversize));
    expect(channel.snapshot(cookieToken).content).toBeNull();
  });

  it("unpaired and paired-without-content reads are byte-identical (no oracle)", () => {
    const { channel: withContent, cookieToken } = pairedChannel(createStatic(CANARY));
    const unpaired = JSON.stringify(withContent.snapshot(undefined));
    const { channel: noContent, cookieToken: token2 } = pairedChannel();
    expect(JSON.stringify(noContent.snapshot(token2))).toBe(unpaired);
    expect(withContent.snapshot(cookieToken).content).not.toBeNull();
  });

  it("rotation cuts access for the prior cookie and grants it to the new one", () => {
    const { channel, cookieToken } = pairedChannel(createStatic(CANARY));
    const rotated = channel.rotate(cookieToken);
    expect(rotated.rotated).toBe(true);
    expect(channel.snapshot(cookieToken).content).toBeNull();
    if (rotated.rotated) expect(channel.snapshot(rotated.cookieToken).content).toEqual(CANARY);
  });

  it("sign-out revokes the session", () => {
    const { channel, cookieToken } = pairedChannel(createStatic(CANARY));
    channel.signOut(cookieToken);
    expect(channel.snapshot(cookieToken).content).toBeNull();
    expect(channel.sessionCount()).toBe(0);
  });

  it("streams bounded updates and detaches when rotation invalidates the original cookie", () => {
    const live = liveSource();
    const { channel, cookieToken } = pairedChannel(live.source);
    const snapshots: string[] = [];
    const subscription = channel.subscribe(cookieToken, (snapshot) => {
      snapshots.push(JSON.stringify(snapshot));
      return true;
    });
    expect(subscription.live).toBe(true);
    expect(subscription.snapshot.content).toEqual(CANARY);
    live.emit({ kind: "probe", body: "second" });
    expect(snapshots.at(-1)).toContain("second");
    channel.rotate(cookieToken);
    live.emit(CANARY);
    expect(snapshots.at(-1)).toContain('"content":null');
    expect(live.subscribers()).toBe(0);
  });

  it("uses passive stream inspection so server updates never extend idle expiry", () => {
    let now = 1_000;
    const registry = createSessionRegistry({
      now: () => now,
      idleTtlMs: 100,
      absoluteTtlMs: 1_000,
    });
    const live = liveSource();
    const channel = createCodingAppSessionChannel({
      registry,
      pairingPort: createFakeSessionPairingPort(),
      contentSource: live.source,
    });
    const paired = channel.pair(fakePairingRequestBody());
    if (!paired.paired) throw new Error("expected pairing");
    const snapshots: string[] = [];
    channel.subscribe(paired.cookieToken, (snapshot) => {
      snapshots.push(JSON.stringify(snapshot));
      return true;
    });
    now += 80;
    live.emit(CANARY);
    now += 21;
    live.emit(CANARY);
    expect(snapshots.at(-1)).toContain('"content":null');
    expect(live.subscribers()).toBe(0);
  });

  it("rejects excess live streams before allocating a source subscription", () => {
    const live = liveSource();
    const { channel, cookieToken } = pairedChannel(live.source);
    const subscriptions = Array.from({ length: CODING_APP_SESSION_MAX_LIVE_STREAMS }, () =>
      channel.subscribe(cookieToken, () => true),
    );
    expect(subscriptions.every(({ live: accepted }) => accepted)).toBe(true);
    expect(live.subscribers()).toBe(CODING_APP_SESSION_MAX_LIVE_STREAMS);

    const excess = channel.subscribe(cookieToken, () => true);

    expect(excess.live).toBe(false);
    expect(live.subscribers()).toBe(CODING_APP_SESSION_MAX_LIVE_STREAMS);
    for (const subscription of subscriptions) subscription.detach();
    expect(live.subscribers()).toBe(0);
  });

  it("releases admission when a source synchronously closes a subscription", () => {
    let synchronousClose = true;
    let detached = 0;
    const source: CodingAppSessionContentSource = {
      contentFor: () => CANARY,
      subscribeContent: (listener) => {
        if (synchronousClose) {
          synchronousClose = false;
          listener(null);
        }
        return {
          admitted: true,
          detach: (): void => {
            detached += 1;
          },
        };
      },
    };
    const { channel, cookieToken } = pairedChannel(source);

    expect(channel.subscribe(cookieToken, () => false).live).toBe(false);
    const subscriptions = Array.from({ length: CODING_APP_SESSION_MAX_LIVE_STREAMS }, () =>
      channel.subscribe(cookieToken, () => true),
    );

    expect(subscriptions.every(({ live }) => live)).toBe(true);
    expect(detached).toBe(1);
    for (const subscription of subscriptions) subscription.detach();
  });

  it("detaches a throwing stream listener and releases its interval and admission slot", () => {
    vi.useFakeTimers();
    try {
      const live = liveSource();
      const { channel, cookieToken } = pairedChannel(live.source);
      const throwing = vi.fn(() => {
        throw new Error("stream-listener-failure");
      });
      expect(channel.subscribe(cookieToken, throwing).live).toBe(true);

      expect(() => {
        live.emit(CANARY);
      }).not.toThrow();
      expect(live.subscribers()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(throwing).toHaveBeenCalledOnce();

      const replacements = Array.from({ length: CODING_APP_SESSION_MAX_LIVE_STREAMS }, () =>
        channel.subscribe(cookieToken, () => true),
      );
      expect(replacements.every(({ live: admitted }) => admitted)).toBe(true);
      for (const replacement of replacements) replacement.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unavailable recovery live and releases the stream slot on feed expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T17:00:00.000Z"));
    try {
      const projection = createCodingSafeActivityProjection({ ttlMs: 100 });
      const open = (runId: string): void => {
        projection.open({
          runId,
          workspaceId: "workspace-safe-activity",
          authorityExpiresAt: "2026-07-18T18:00:00.000Z",
          workspaceIsCurrent: () => true,
        });
      };
      open("run-safe-activity-1");
      const { channel, cookieToken } = pairedChannel({
        contentFor: () => projection.currentContent(),
        subscribeContent: (listener) => projection.subscribeContent(listener),
      });
      const snapshots: string[] = [];
      const subscription = channel.subscribe(cookieToken, (snapshot) => {
        snapshots.push(JSON.stringify(snapshot));
        return snapshot.content !== null;
      });

      projection.markUnavailable("run-safe-activity-1");
      open("run-safe-activity-2");
      expect(snapshots.at(-2)).toContain('"availability":"unavailable"');
      expect(snapshots.at(-1)).toContain('"availability":"available"');
      projection.markUnavailable("run-safe-activity-2");
      vi.advanceTimersByTime(101);
      expect(snapshots.at(-1)).toContain('"content":null');

      open("run-safe-activity-3");
      const replacements = Array.from({ length: CODING_APP_SESSION_MAX_LIVE_STREAMS }, () =>
        channel.subscribe(cookieToken, () => true),
      );
      expect(replacements.every(({ live }) => live)).toBe(true);
      subscription.detach();
      for (const replacement of replacements) replacement.detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotate and sign-out on an unpaired cookie are safe no-ops", () => {
    const channel = createCodingAppSessionChannel({
      registry: createSessionRegistry(),
      pairingPort: createFakeSessionPairingPort(),
    });
    expect(channel.rotate(undefined)).toEqual({ rotated: false });
    expect(() => {
      channel.signOut(undefined);
    }).not.toThrow();
  });

  // #2478: verifySession is the read-authority primitive the W1.5 route guard enforces with.
  it("verifySession grants only a live cookie and nothing after revocation or rotation", () => {
    const { channel, cookieToken } = pairedChannel();
    expect(channel.verifySession(cookieToken)?.principalLabel).toBe("test-operator");
    expect(channel.verifySession(undefined)).toBeUndefined();
    expect(channel.verifySession("sess_000000000000000000000000.wrong")).toBeUndefined();
    const rotated = channel.rotate(cookieToken);
    expect(rotated.rotated).toBe(true);
    expect(channel.verifySession(cookieToken)).toBeUndefined();
    if (rotated.rotated) {
      channel.signOut(rotated.cookieToken);
      expect(channel.verifySession(rotated.cookieToken)).toBeUndefined();
    }
  });
});

function createStatic(content: { kind: string; body: string }): CodingAppSessionContentSource {
  return { contentFor: () => content };
}
