import type { ServerResponse } from "node:http";

import {
  EDITOR_M7_SCHEMA_VERSION,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingsEvent,
  type EditorM7SettingsSnapshot,
} from "@oscharko-dev/keiko-contracts";

import { writeOrDestroy } from "../../sse-write.js";
import { editorSettingsWorkspaceFingerprint } from "./editorSettingsStore.js";

interface EditorSettingsSubscriber {
  readonly controller: AbortController;
  readonly res: ServerResponse;
  readonly rootKey?: string | undefined;
}

export interface EditorSettingsEventBus {
  readonly publish: (args: EditorSettingsPublishArgs) => void;
  readonly subscribe: (args: EditorSettingsSubscribeArgs) => () => void;
}

export interface EditorSettingsPublishArgs {
  readonly snapshot: EditorM7SettingsSnapshot;
  readonly scope: EditorM7SettingScope;
  readonly settingIds: readonly EditorM7SettingId[];
}

export interface EditorSettingsSubscribeArgs {
  readonly controller: AbortController;
  readonly res: ServerResponse;
  readonly realRoot?: string | undefined;
}

export function editorSettingsEventRootKey(realRoot: string | undefined): string | undefined {
  return realRoot === undefined ? undefined : editorSettingsWorkspaceFingerprint(realRoot);
}

function snapshotRootKey(snapshot: EditorM7SettingsSnapshot): string | undefined {
  return snapshot.root === undefined ? undefined : editorSettingsEventRootKey(snapshot.root);
}

function eventMatches(
  subscriber: EditorSettingsSubscriber,
  args: EditorSettingsPublishArgs,
): boolean {
  if (args.scope === "user") return true;
  return subscriber.rootKey !== undefined && subscriber.rootKey === snapshotRootKey(args.snapshot);
}

function frame(event: EditorM7SettingsEvent): string {
  return `id: ${String(event.sequence)}\nevent: editor-settings:changed\ndata: ${JSON.stringify(
    event,
  )}\n\n`;
}

function readyFrame(): string {
  return `event: ready\ndata: {}\n\n`;
}

function eventFromPublish(
  sequence: number,
  args: EditorSettingsPublishArgs,
): EditorM7SettingsEvent {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    sequence,
    kind: "changed",
    revision: args.snapshot.revision,
    userRevision: args.snapshot.userRevision,
    workspaceRevision: args.snapshot.workspaceRevision,
    scope: args.scope,
    settingIds: args.settingIds,
    storeState: args.snapshot.storeState,
  };
}

export function createEditorSettingsEventBus(): EditorSettingsEventBus {
  const subscribers = new Set<EditorSettingsSubscriber>();
  let sequence = 0;
  return {
    publish: (args): void => {
      sequence += 1;
      const payload = eventFromPublish(sequence, args);
      const encoded = frame(payload);
      for (const subscriber of subscribers) {
        if (eventMatches(subscriber, args)) {
          writeOrDestroy(subscriber.res, encoded, subscriber.controller);
        }
      }
    },
    subscribe: (args): (() => void) => {
      const subscriber: EditorSettingsSubscriber = {
        controller: args.controller,
        res: args.res,
        rootKey: editorSettingsEventRootKey(args.realRoot),
      };
      subscribers.add(subscriber);
      args.res.write(readyFrame());
      const unsubscribe = (): void => {
        subscribers.delete(subscriber);
      };
      args.res.on("close", unsubscribe);
      args.controller.signal.addEventListener("abort", unsubscribe, { once: true });
      return unsubscribe;
    },
  };
}
