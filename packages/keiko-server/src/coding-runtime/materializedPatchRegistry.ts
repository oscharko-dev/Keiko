import { sha256Hex } from "@oscharko-dev/keiko-security";
import { EDITOR_AGENT_REVIEW_TIMEOUT_MS } from "../editor/agentSessionRegistry.js";

/**
 * The provenance of a rendered diff (#3873 review).
 *
 * keiko-tools refuses any diff that carries a literal backslash-n before a `+`, `-` or a space: its
 * guard against a model that collapses a diff's lines into one. A replacement edit never reaches
 * that guard as model text. The server renders its diff itself, from the bytes of a governed read of
 * the real file (codingToolReplacementEdits.ts), so a body line that spells a backslash and an "n"
 * is file text, and ordinary source files carry such lines (a table header, an escaped string in a
 * test). The editor route therefore lifts that one heuristic, and only for a diff whose exact text
 * is registered here by the edit port that rendered it. The model and the browser never supply the
 * provenance: they can neither write this registry nor name a digest in a request, and a diff that
 * differs by one byte from a rendered one is not registered.
 *
 * The registry keeps SHA-256 digests only, never patch text. It is bounded twice: by age, and by
 * count, dropping the oldest digest first. A registration is not consumed by a lookup: the route
 * decides at admission and again when the browser reports its review, so the same rendered text is
 * asked about twice, and two runs may render the same text at once. A digest certifies a text, not
 * an action, so a repeated lookup grants nothing a first one did not.
 *
 * It is process-local on purpose: the edit port that registers and the editor route that asks run
 * in one BFF process, over a loopback request, and a composition builds exactly one registry for
 * both (deps.ts). A registry that outlived the process, or sat between two, would be a second
 * source of provenance with its own lifetime; a restart that drops it also drops every pending
 * review, so nothing is left waiting for a registration that is gone.
 */
export interface MaterializedPatchRegistryStats {
  /** Digests currently held, expired ones not yet dropped included. */
  readonly entries: number;
  /** Digests dropped because the registry was full, since the registry was created. */
  readonly evicted: number;
  /** Digests dropped because their lifetime ended, since the registry was created. */
  readonly expired: number;
}

export interface MaterializedPatchLookup {
  readonly registered: boolean;
  /** SHA-256 of the exact patch text asked about: the registry key, never the text itself. */
  readonly patchSha256: string;
}

export interface MaterializedPatchRegistry {
  /** Records that this exact patch text was rendered by the server from governed file reads. */
  readonly register: (patch: string) => void;
  /** Whether this exact patch text is registered and its registration has not expired. */
  readonly lookup: (patch: string) => MaterializedPatchLookup;
  readonly stats: () => MaterializedPatchRegistryStats;
}

export interface MaterializedPatchRegistryOptions {
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  readonly maxEntries?: number | undefined;
}

/**
 * Registrations outlive the editor's own review window: a changeset waits up to
 * `EDITOR_AGENT_REVIEW_TIMEOUT_MS` for the human's decision, and the route asks again when that
 * decision arrives, so a shorter lifetime would refuse a change the human had just approved.
 */
export const MATERIALIZED_PATCH_TTL_MS = EDITOR_AGENT_REVIEW_TIMEOUT_MS + 60_000;

/** The same bound as the route's idempotency map: a long-lived server cannot grow it further. */
export const MATERIALIZED_PATCH_MAX_ENTRIES = 1_024;

export function createMaterializedPatchRegistry(
  options: MaterializedPatchRegistryOptions = {},
): MaterializedPatchRegistry {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? MATERIALIZED_PATCH_TTL_MS;
  // A registry that held nothing could never recognize the diff it was just given.
  const maxEntries = Math.max(1, options.maxEntries ?? MATERIALIZED_PATCH_MAX_ENTRIES);
  // digest -> the instant its registration ends. A Map iterates in insertion order and a
  // re-registration deletes before it sets, so the first key is always the oldest registration.
  const deadlines = new Map<string, number>();
  const counters = { evicted: 0, expired: 0 };

  // Makes room for one more digest: ended registrations go first, then the oldest live ones.
  function makeRoom(at: number): void {
    for (const [digest, deadline] of deadlines) {
      if (deadline > at) continue;
      deadlines.delete(digest);
      counters.expired += 1;
    }
    for (const digest of deadlines.keys()) {
      if (deadlines.size < maxEntries) break;
      deadlines.delete(digest);
      counters.evicted += 1;
    }
  }

  return {
    register: (patch): void => {
      const at = now();
      const digest = sha256Hex(patch);
      deadlines.delete(digest);
      makeRoom(at);
      deadlines.set(digest, at + ttlMs);
    },
    lookup: (patch): MaterializedPatchLookup => {
      const patchSha256 = sha256Hex(patch);
      const deadline = deadlines.get(patchSha256);
      if (deadline === undefined) return { registered: false, patchSha256 };
      if (deadline <= now()) {
        deadlines.delete(patchSha256);
        counters.expired += 1;
        return { registered: false, patchSha256 };
      }
      return { registered: true, patchSha256 };
    },
    stats: (): MaterializedPatchRegistryStats => ({
      entries: deadlines.size,
      evicted: counters.evicted,
      expired: counters.expired,
    }),
  };
}
