"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import {
  EDITOR_M7_SCHEMA_VERSION,
  defaultEditorM7Settings,
  parseEditorM7SettingsEvent,
  type EditorM7LargeFileMode,
  type EditorM7ResolvedSetting,
  type EditorM7SettingId,
  type EditorM7SettingScope,
  type EditorM7SettingValue,
  type EditorM7SettingsMutationAction,
  type EditorM7SettingsSnapshot,
  type EditorM7WhitespaceRendering,
  type EditorM7WordWrap,
} from "@oscharko-dev/keiko-contracts";
import { ApiError, fetchEditorSettings, mutateEditorSettings } from "../../../../../lib/api";
import { subscribeSharedEventSource } from "./sharedEventSource";

export interface AppliedEditorSettings {
  readonly fontSize: number;
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly wordWrap: EditorM7WordWrap;
  readonly renderWhitespace: EditorM7WhitespaceRendering;
  readonly minimap: boolean;
  readonly formatOnSave: boolean;
  readonly largeFileMode: EditorM7LargeFileMode;
  readonly keybindingOverrides: readonly string[];
}

export type EditorSettingsIssue = "load" | "mutation" | "conflict";

export interface EditorSettingsView {
  readonly snapshot: EditorM7SettingsSnapshot | undefined;
  readonly applied: AppliedEditorSettings;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: EditorSettingsIssue | undefined;
  readonly announcement: string;
  readonly refresh: () => Promise<void>;
  readonly setValue: (
    scope: EditorM7SettingScope,
    id: EditorM7SettingId,
    value: EditorM7SettingValue,
  ) => Promise<void>;
  readonly reset: (scope: EditorM7SettingScope, ids: readonly EditorM7SettingId[]) => Promise<void>;
}

const defaults = defaultEditorM7Settings();

export const DEFAULT_APPLIED_EDITOR_SETTINGS: AppliedEditorSettings = {
  fontSize: numberSetting(defaults.fontSize, 13),
  tabSize: numberSetting(defaults.tabSize, 2),
  insertSpaces: booleanSetting(defaults.insertSpaces, true),
  wordWrap: wordWrapSetting(defaults.wordWrap),
  renderWhitespace: whitespaceSetting(defaults.renderWhitespace),
  minimap: booleanSetting(defaults.minimap, false),
  formatOnSave: booleanSetting(defaults.formatOnSave, false),
  largeFileMode: largeFileModeSetting(defaults.largeFileMode),
  keybindingOverrides: stringArraySetting(defaults.keybindingOverrides),
};

let fallbackId = 0;

function idempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  fallbackId += 1;
  return `editor-settings-ui-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortControllerRef(ref: MutableRefObject<AbortController | undefined>): void {
  ref.current?.abort();
}

function eventsUrl(root: string | undefined): string {
  return root === undefined || root.length === 0
    ? "/api/editor/settings/events"
    : `/api/editor/settings/events?root=${encodeURIComponent(root)}`;
}

export function useEditorSettings(root: string | undefined): EditorSettingsView {
  const rootRef = useRef(root);
  const readAbort = useRef<AbortController | undefined>(undefined);
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<EditorM7SettingsSnapshot | undefined>();
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [issue, setIssue] = useState<EditorSettingsIssue | undefined>();
  const [announcement, setAnnouncement] = useState("");
  rootRef.current = root;

  const refresh = useCallback(async (): Promise<void> => {
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    setLoading(true);
    setIssue(undefined);
    try {
      const data = await fetchEditorSettings(root, controller.signal);
      if (rootRef.current !== root || controller.signal.aborted) return;
      setSnapshot(data);
      setIssue(undefined);
    } catch (error: unknown) {
      if (aborted(error) || rootRef.current !== root) return;
      setIssue("load");
    } finally {
      if (rootRef.current === root && !controller.signal.aborted) setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    setSnapshot(undefined);
    setLoading(true);
    setMutating(false);
    setIssue(undefined);
    setAnnouncement("");
    void refresh();
    return () => {
      abortControllerRef(readAbort);
      abortControllerRef(mutationAbort);
    };
  }, [refresh]);

  useEffect(() => {
    const unsubscribe = subscribeSharedEventSource(
      eventsUrl(root),
      ["ready", "editor-settings:changed"],
      (event) => {
        if (event.type === "ready") {
          void refresh();
          return;
        }
        try {
          const parsed = parseEditorM7SettingsEvent(JSON.parse(event.data));
          if (parsed.ok) void refresh();
        } catch {
          void refresh();
        }
      },
    );
    return unsubscribe;
  }, [refresh, root]);

  const reset = useCallback(
    async (scope: EditorM7SettingScope, ids: readonly EditorM7SettingId[]): Promise<void> => {
      if (ids.length === 0) return;
      await executeMutation({
        action: "reset",
        ids,
        root,
        scope,
        setAnnouncement,
        setIssue,
        setMutating,
        setSnapshot,
        signalRef: mutationAbort,
        snapshot,
      });
    },
    [root, snapshot],
  );

  const setValue = useCallback(
    async (
      scope: EditorM7SettingScope,
      id: EditorM7SettingId,
      value: EditorM7SettingValue,
    ): Promise<void> => {
      await executeMutation({
        action: "set",
        id,
        root,
        scope,
        setAnnouncement,
        setIssue,
        setMutating,
        setSnapshot,
        signalRef: mutationAbort,
        snapshot,
        value,
      });
    },
    [root, snapshot],
  );

  const applied = useMemo(() => appliedEditorSettings(snapshot), [snapshot]);
  return { snapshot, applied, loading, mutating, issue, announcement, refresh, setValue, reset };
}

interface MutationArgs {
  readonly action: EditorM7SettingsMutationAction;
  readonly root: string | undefined;
  readonly scope: EditorM7SettingScope;
  readonly snapshot: EditorM7SettingsSnapshot | undefined;
  readonly signalRef: MutableRefObject<AbortController | undefined>;
  readonly setSnapshot: (snapshot: EditorM7SettingsSnapshot) => void;
  readonly setMutating: (mutating: boolean) => void;
  readonly setIssue: (issue: EditorSettingsIssue | undefined) => void;
  readonly setAnnouncement: (announcement: string) => void;
  readonly id?: EditorM7SettingId | undefined;
  readonly value?: EditorM7SettingValue | undefined;
  readonly ids?: readonly EditorM7SettingId[] | undefined;
}

async function executeMutation(args: MutationArgs): Promise<void> {
  if (args.snapshot === undefined) return;
  const id = args.id;
  const value = args.value;
  if (args.action === "set" && (id === undefined || value === undefined)) return;
  args.signalRef.current?.abort();
  const controller = new AbortController();
  args.signalRef.current = controller;
  args.setMutating(true);
  args.setIssue(undefined);
  args.setAnnouncement("");
  const expectedRevision =
    args.scope === "user" ? args.snapshot.userRevision : args.snapshot.workspaceRevision;
  try {
    const body =
      args.action === "set"
        ? {
            schemaVersion: EDITOR_M7_SCHEMA_VERSION,
            ...(args.root === undefined ? {} : { root: args.root }),
            scope: args.scope,
            action: args.action,
            expectedRevision,
            values: { [id as EditorM7SettingId]: value as EditorM7SettingValue },
          }
        : {
            schemaVersion: EDITOR_M7_SCHEMA_VERSION,
            ...(args.root === undefined ? {} : { root: args.root }),
            scope: args.scope,
            action: args.action,
            expectedRevision,
            settingIds: args.ids ?? [],
          };
    const result = await mutateEditorSettings(
      body,
      args.snapshot.etag,
      idempotencyKey(),
      controller.signal,
    );
    if (controller.signal.aborted || result.kind !== "ok") return;
    args.setSnapshot(result.snapshot);
    args.setAnnouncement(`${args.action}:${args.scope}`);
  } catch (error: unknown) {
    if (aborted(error)) return;
    args.setIssue(
      error instanceof ApiError && error.code === "STALE_REVISION" ? "conflict" : "mutation",
    );
  } finally {
    if (!controller.signal.aborted) args.setMutating(false);
  }
}

export function appliedEditorSettings(
  snapshot: EditorM7SettingsSnapshot | undefined,
): AppliedEditorSettings {
  if (snapshot === undefined) return DEFAULT_APPLIED_EDITOR_SETTINGS;
  return {
    fontSize: numberSetting(
      settingValue(snapshot, "fontSize"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.fontSize,
    ),
    tabSize: numberSetting(
      settingValue(snapshot, "tabSize"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.tabSize,
    ),
    insertSpaces: booleanSetting(
      settingValue(snapshot, "insertSpaces"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.insertSpaces,
    ),
    wordWrap: wordWrapSetting(settingValue(snapshot, "wordWrap")),
    renderWhitespace: whitespaceSetting(settingValue(snapshot, "renderWhitespace")),
    minimap: booleanSetting(
      settingValue(snapshot, "minimap"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.minimap,
    ),
    formatOnSave: booleanSetting(
      settingValue(snapshot, "formatOnSave"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.formatOnSave,
    ),
    largeFileMode: largeFileModeSetting(settingValue(snapshot, "largeFileMode")),
    keybindingOverrides: stringArraySetting(settingValue(snapshot, "keybindingOverrides")),
  };
}

export function settingById(
  snapshot: EditorM7SettingsSnapshot | undefined,
  id: EditorM7SettingId,
): EditorM7ResolvedSetting | undefined {
  return snapshot?.settings.find((setting) => setting.id === id);
}

function settingValue(
  snapshot: EditorM7SettingsSnapshot,
  id: EditorM7SettingId,
): EditorM7SettingValue | undefined {
  return settingById(snapshot, id)?.value;
}

function numberSetting(value: EditorM7SettingValue | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function booleanSetting(value: EditorM7SettingValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArraySetting(value: EditorM7SettingValue | undefined): readonly string[] {
  return Array.isArray(value) ? value : [];
}

function wordWrapSetting(value: EditorM7SettingValue | undefined): EditorM7WordWrap {
  return value === "on" || value === "wordWrapColumn" || value === "bounded" ? value : "off";
}

function whitespaceSetting(value: EditorM7SettingValue | undefined): EditorM7WhitespaceRendering {
  return value === "none" || value === "boundary" || value === "all" ? value : "selection";
}

function largeFileModeSetting(value: EditorM7SettingValue | undefined): EditorM7LargeFileMode {
  return value === "degraded" || value === "readonly" ? value : "default";
}
