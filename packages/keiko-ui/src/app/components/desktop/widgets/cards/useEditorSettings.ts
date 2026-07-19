"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import {
  EDITOR_M7_SCHEMA_VERSION,
  EDITOR_M7_SETTING_REGISTRY,
  EDITOR_M11_DEFAULT_PROFILE_REF,
  defaultEditorM7Settings,
  parseEditorM11SettingsEvent,
  type EditorM7ExternalReloadPolicy,
  type EditorM7LargeFileMode,
  type EditorM7SettingId,
  type EditorM7SettingValue,
  type EditorM7SettingsMutationAction,
  type EditorM7WhitespaceRendering,
  type EditorM7WordWrap,
  type EditorM11ResolvedSetting,
  type EditorM11ProfileMutationAction,
  type EditorM11SettingScope,
  type EditorM11SettingsSnapshot,
  type WorkspaceProfileRef,
} from "@oscharko-dev/keiko-contracts";
import {
  ApiError,
  fetchEditorSettings,
  mutateEditorProfile,
  mutateEditorSettings,
} from "../../../../../lib/api";
import { subscribeSharedEventSource } from "./sharedEventSource";

interface AppliedEditorSettings {
  readonly fontSize: number;
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly wordWrap: EditorM7WordWrap;
  readonly renderWhitespace: EditorM7WhitespaceRendering;
  readonly minimap: boolean;
  readonly formatOnSave: boolean;
  readonly externalReload: EditorM7ExternalReloadPolicy;
  readonly largeFileMode: EditorM7LargeFileMode;
  readonly keybindingOverrides: readonly string[];
  readonly modelRetentionCount: number;
  readonly modelRetentionBytes: number;
}

export type EditorSettingsIssue = "load" | "mutation" | "conflict";
export type EditorSettingsEditScope = EditorM11SettingScope | "profile";

export interface EditorSettingsView {
  readonly snapshot: EditorM11SettingsSnapshot | undefined;
  readonly applied: AppliedEditorSettings;
  readonly loading: boolean;
  readonly mutating: boolean;
  readonly issue: EditorSettingsIssue | undefined;
  readonly announcement: string;
  readonly refresh: () => Promise<void>;
  readonly setValue: (
    scope: EditorSettingsEditScope,
    id: EditorM7SettingId,
    value: EditorM7SettingValue,
  ) => Promise<void>;
  readonly reset: (
    scope: EditorSettingsEditScope,
    ids: readonly EditorM7SettingId[],
  ) => Promise<void>;
  readonly createProfile: (displayName: string) => Promise<void>;
  readonly renameProfile: (profileRef: WorkspaceProfileRef, displayName: string) => Promise<void>;
  readonly duplicateProfile: (
    profileRef: WorkspaceProfileRef,
    displayName: string,
  ) => Promise<void>;
  readonly deleteProfile: (profileRef: WorkspaceProfileRef) => Promise<void>;
  readonly switchProfile: (profileRef: WorkspaceProfileRef) => Promise<void>;
  readonly resetProfile: (profileRef: WorkspaceProfileRef) => Promise<void>;
}

const defaults = defaultEditorM7Settings();

const DEFAULT_APPLIED_EDITOR_SETTINGS: AppliedEditorSettings = {
  fontSize: numberSetting(defaults.fontSize, 13),
  tabSize: numberSetting(defaults.tabSize, 2),
  insertSpaces: booleanSetting(defaults.insertSpaces, true),
  wordWrap: wordWrapSetting(defaults.wordWrap),
  renderWhitespace: whitespaceSetting(defaults.renderWhitespace),
  minimap: booleanSetting(defaults.minimap, false),
  formatOnSave: booleanSetting(defaults.formatOnSave, false),
  externalReload: externalReloadSetting(defaults.externalReload),
  largeFileMode: largeFileModeSetting(defaults.largeFileMode),
  keybindingOverrides: stringArraySetting(defaults.keybindingOverrides),
  modelRetentionCount: numberSetting(defaults.modelRetentionCount, 32),
  modelRetentionBytes: numberSetting(defaults.modelRetentionBytes, 64 * 1024 * 1024),
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

function abortControllerRef(ref: RefObject<AbortController | undefined>): void {
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
  const [snapshot, setSnapshot] = useState<EditorM11SettingsSnapshot | undefined>();
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
          const parsed = parseEditorM11SettingsEvent(JSON.parse(event.data));
          if (parsed.ok) void refresh();
        } catch {
          void refresh();
        }
      },
    );
    return unsubscribe;
  }, [refresh, root]);

  const reset = useCallback(
    async (scope: EditorSettingsEditScope, ids: readonly EditorM7SettingId[]): Promise<void> => {
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
      scope: EditorSettingsEditScope,
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

  const mutateProfile = useCallback(
    async (
      action: EditorM11ProfileMutationAction,
      profileRef?: WorkspaceProfileRef,
      displayName?: string,
      settingIds?: readonly EditorM7SettingId[],
    ): Promise<void> => {
      await executeProfileMutation({
        action,
        displayName,
        profileRef,
        root,
        setAnnouncement,
        setIssue,
        setMutating,
        setSnapshot,
        signalRef: mutationAbort,
        snapshot,
        settingIds,
      });
    },
    [root, snapshot],
  );

  return {
    snapshot,
    applied,
    loading,
    mutating,
    issue,
    announcement,
    refresh,
    setValue,
    reset,
    createProfile: (displayName): Promise<void> => mutateProfile("create", undefined, displayName),
    renameProfile: (profileRef, displayName): Promise<void> =>
      mutateProfile("rename", profileRef, displayName),
    duplicateProfile: (profileRef, displayName): Promise<void> =>
      mutateProfile("duplicate", profileRef, displayName),
    deleteProfile: (profileRef): Promise<void> => mutateProfile("delete", profileRef),
    switchProfile: (profileRef): Promise<void> => mutateProfile("switch", profileRef),
    resetProfile: (profileRef): Promise<void> =>
      mutateProfile(
        "reset",
        profileRef,
        undefined,
        EDITOR_M7_SETTING_REGISTRY.filter((definition) => definition.scopes.includes("user")).map(
          (definition) => definition.id,
        ),
      ),
  };
}

interface MutationArgs {
  readonly action: EditorM7SettingsMutationAction;
  readonly root: string | undefined;
  readonly scope: EditorSettingsEditScope;
  readonly snapshot: EditorM11SettingsSnapshot | undefined;
  readonly signalRef: RefObject<AbortController | undefined>;
  readonly setSnapshot: (snapshot: EditorM11SettingsSnapshot) => void;
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
  if (args.scope === "profile") {
    await executeProfileSettingMutation(args, id, value);
    return;
  }
  const scope = args.scope;
  args.signalRef.current?.abort();
  const controller = new AbortController();
  args.signalRef.current = controller;
  args.setMutating(true);
  args.setIssue(undefined);
  args.setAnnouncement("");
  const expectedRevision =
    scope === "user"
      ? args.snapshot.userRevision
      : scope === "workspace"
        ? args.snapshot.workspaceRevision
        : (args.snapshot.rootRevision ?? 0);
  try {
    const body = mutationBody(args, scope, expectedRevision, id, value);
    const result = await mutateEditorSettings(
      body,
      args.snapshot.etag,
      idempotencyKey(),
      controller.signal,
    );
    if (controller.signal.aborted || result.kind !== "ok") return;
    args.setSnapshot(result.snapshot);
    args.setAnnouncement(`${args.action}:${scope}`);
  } catch (error: unknown) {
    if (aborted(error)) return;
    args.setIssue(
      error instanceof ApiError && error.code === "STALE_REVISION" ? "conflict" : "mutation",
    );
  } finally {
    if (!controller.signal.aborted) args.setMutating(false);
  }
}

function mutationBody(
  args: MutationArgs,
  scope: EditorM11SettingScope,
  expectedRevision: number,
  id: EditorM7SettingId | undefined,
  value: EditorM7SettingValue | undefined,
): Parameters<typeof mutateEditorSettings>[0] {
  const base = {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    ...(args.root === undefined ? {} : { root: args.root }),
    scope,
    expectedRevision,
  };
  if (args.action !== "set") return { ...base, action: args.action, settingIds: args.ids ?? [] };
  return {
    ...base,
    action: args.action,
    values: { [id as EditorM7SettingId]: value as EditorM7SettingValue },
  };
}

async function executeProfileSettingMutation(
  args: MutationArgs,
  id: EditorM7SettingId | undefined,
  value: EditorM7SettingValue | undefined,
): Promise<void> {
  const profiles = args.snapshot?.profiles;
  if (
    profiles === undefined ||
    profiles.activeProfileRef === EDITOR_M11_DEFAULT_PROFILE_REF ||
    (args.action === "set" && (id === undefined || value === undefined))
  ) {
    return;
  }
  args.signalRef.current?.abort();
  const controller = new AbortController();
  args.signalRef.current = controller;
  args.setMutating(true);
  args.setIssue(undefined);
  args.setAnnouncement("");
  try {
    const result = await mutateEditorProfile(
      profileSettingMutationBody(args, profiles.activeProfileRef, profiles.revision, id, value),
      profiles.etag,
      idempotencyKey(),
      controller.signal,
    );
    if (controller.signal.aborted || result.kind !== "ok") return;
    args.setSnapshot(result.settings);
    args.setAnnouncement(`${args.action}:profile`);
  } catch (error: unknown) {
    if (!aborted(error)) args.setIssue(issueFromMutationError(error));
  } finally {
    if (!controller.signal.aborted) args.setMutating(false);
  }
}

function profileSettingMutationBody(
  args: MutationArgs,
  profileRef: WorkspaceProfileRef,
  expectedRevision: number,
  id: EditorM7SettingId | undefined,
  value: EditorM7SettingValue | undefined,
): Parameters<typeof mutateEditorProfile>[0] {
  const base = {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    action: args.action,
    expectedRevision,
    profileRef,
    ...(args.root === undefined ? {} : { root: args.root }),
  };
  return args.action === "set"
    ? { ...base, values: { [id as EditorM7SettingId]: value as EditorM7SettingValue } }
    : { ...base, settingIds: args.ids ?? [] };
}

interface ProfileEntityMutationArgs {
  readonly action: EditorM11ProfileMutationAction;
  readonly root: string | undefined;
  readonly snapshot: EditorM11SettingsSnapshot | undefined;
  readonly signalRef: RefObject<AbortController | undefined>;
  readonly setSnapshot: (snapshot: EditorM11SettingsSnapshot) => void;
  readonly setMutating: (mutating: boolean) => void;
  readonly setIssue: (issue: EditorSettingsIssue | undefined) => void;
  readonly setAnnouncement: (announcement: string) => void;
  readonly profileRef?: WorkspaceProfileRef | undefined;
  readonly displayName?: string | undefined;
  readonly settingIds?: readonly EditorM7SettingId[] | undefined;
}

async function executeProfileMutation(args: ProfileEntityMutationArgs): Promise<void> {
  const profiles = args.snapshot?.profiles;
  if (profiles === undefined) return;
  args.signalRef.current?.abort();
  const controller = new AbortController();
  args.signalRef.current = controller;
  args.setMutating(true);
  args.setIssue(undefined);
  args.setAnnouncement("");
  try {
    const result = await mutateEditorProfile(
      profileEntityMutationBody(args, profiles.revision),
      profiles.etag,
      idempotencyKey(),
      controller.signal,
    );
    if (controller.signal.aborted || result.kind !== "ok") return;
    args.setSnapshot(result.settings);
    args.setAnnouncement(`${args.action}:profile`);
  } catch (error: unknown) {
    if (!aborted(error)) args.setIssue(issueFromMutationError(error));
  } finally {
    if (!controller.signal.aborted) args.setMutating(false);
  }
}

function profileEntityMutationBody(
  args: ProfileEntityMutationArgs,
  expectedRevision: number,
): Parameters<typeof mutateEditorProfile>[0] {
  return {
    schemaVersion: EDITOR_M7_SCHEMA_VERSION,
    action: args.action,
    expectedRevision,
    ...(args.root === undefined ? {} : { root: args.root }),
    ...(args.profileRef === undefined ? {} : { profileRef: args.profileRef }),
    ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
    ...(args.settingIds === undefined ? {} : { settingIds: args.settingIds }),
  };
}

function issueFromMutationError(error: unknown): EditorSettingsIssue {
  return error instanceof ApiError && error.code === "STALE_REVISION" ? "conflict" : "mutation";
}

function appliedEditorSettings(
  snapshot: EditorM11SettingsSnapshot | undefined,
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
    externalReload: externalReloadSetting(settingValue(snapshot, "externalReload")),
    largeFileMode: largeFileModeSetting(settingValue(snapshot, "largeFileMode")),
    keybindingOverrides: stringArraySetting(settingValue(snapshot, "keybindingOverrides")),
    modelRetentionCount: numberSetting(
      settingValue(snapshot, "modelRetentionCount"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.modelRetentionCount,
    ),
    modelRetentionBytes: numberSetting(
      settingValue(snapshot, "modelRetentionBytes"),
      DEFAULT_APPLIED_EDITOR_SETTINGS.modelRetentionBytes,
    ),
  };
}

export function settingById(
  snapshot: EditorM11SettingsSnapshot | undefined,
  id: EditorM7SettingId,
): EditorM11ResolvedSetting | undefined {
  return snapshot?.settings.find((setting) => setting.id === id);
}

function settingValue(
  snapshot: EditorM11SettingsSnapshot,
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

function externalReloadSetting(
  value: EditorM7SettingValue | undefined,
): EditorM7ExternalReloadPolicy {
  return value === "autoClean" || value === "manual" ? value : "prompt";
}
