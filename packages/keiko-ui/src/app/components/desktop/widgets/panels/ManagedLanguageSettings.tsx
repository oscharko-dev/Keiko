"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  ManagedLspActivationReasonCode,
  ManagedLspActivationResolution,
  ManagedLspEffectiveState,
  ManagedLspLanguage,
  ManagedLspProcessHealthSnapshot,
  ManagedLspRuntimeConfiguration,
} from "@oscharko-dev/keiko-contracts";
import type { ManagedLspConfigurationSummary, ManagedLspSettingsAction } from "@/lib/api";
import { useTranslate } from "@/lib/i18n";

import styles from "./ManagedLanguageSettings.module.css";
import { managedLanguageTranslate, type ManagedLanguageTranslate } from "./managed-language-i18n";
import { useManagedLanguageSettings } from "./useManagedLanguageSettings";

const MAX_CAPABILITIES = 12;

interface Confirmation {
  readonly action: Exclude<ManagedLspSettingsAction, "activate" | "configure">;
  readonly language: ManagedLspLanguage;
  readonly opener: HTMLButtonElement;
}

export function ManagedLanguageSettings({
  root,
}: {
  readonly root?: string | undefined;
}): ReactNode {
  const t = managedLanguageTranslate(useTranslate());
  const view = useManagedLanguageSettings(root);
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | undefined>(undefined);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const pendingRestoreTargetRef = useRef<HTMLButtonElement | undefined>(undefined);

  useEffect(() => {
    if (confirmation !== undefined) {
      cancelRef.current?.focus();
      return;
    }
    const opener = restoreFocusRef.current;
    restoreFocusRef.current = undefined;
    if (opener === undefined) return;
    if (opener.isConnected) {
      opener.focus();
      pendingRestoreTargetRef.current = opener;
    } else {
      titleRef.current?.focus();
    }
  }, [confirmation]);

  useEffect(() => {
    const target = pendingRestoreTargetRef.current;
    pendingRestoreTargetRef.current = undefined;
    // A confirmed action's server-acknowledged state (e.g. restart -> active) can drop the opener
    // button from actionsFor() on this later data-driven render. The browser already moved focus
    // to <body> when that node was removed from the DOM; recover it onto the stable section title
    // instead of leaving keyboard focus unmanaged.
    if (target !== undefined && !target.isConnected && document.activeElement === document.body) {
      titleRef.current?.focus();
    }
  }, [view.data]);

  const closeConfirmation = (): void => {
    restoreFocusRef.current = confirmation?.opener;
    setConfirmation(undefined);
  };

  const confirmAction = (): void => {
    if (confirmation === undefined) return;
    const { action, language } = confirmation;
    closeConfirmation();
    void view.apply(language, action);
  };

  return (
    <section className={styles.section} aria-labelledby="managed-language-settings-title">
      <header className={styles.header}>
        <h3
          className={styles.title}
          id="managed-language-settings-title"
          ref={titleRef}
          tabIndex={-1}
        >
          {t("title")}
        </h3>
        <p className={styles.description}>{t("description")}</p>
      </header>
      <output className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {announcement(view.announcement, t)}
        {view.mutating ? t("applying") : ""}
      </output>
      {root === undefined ? <p className={styles.empty}>{t("noWorkspace")}</p> : null}
      {root !== undefined && view.loading && view.data === undefined ? (
        <p className={styles.empty} role="status">
          {t("loading")}
        </p>
      ) : null}
      {view.issue !== undefined ? (
        <div className={styles.alert} role="alert">
          <span>{view.issue === "conflict" ? t("conflict") : issueCopy(view.issue, t)}</span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              void (view.pendingIntent === undefined ? view.refresh() : view.retryIntent());
            }}
          >
            {view.pendingIntent === undefined ? t("retry") : t("retryIntent")}
          </button>
        </div>
      ) : null}
      {view.data !== undefined ? (
        <div className={styles.list}>
          {view.data.languages.flatMap((entry) =>
            entry.ok
              ? [
                  <LanguageCard
                    key={entry.language}
                    status={entry}
                    configuration={view.data?.settings.find(
                      (item) => item.language === entry.language,
                    )}
                    health={view.data?.health.find((item) => item.language === entry.language)}
                    runtimeConfiguration={view.data?.configurations.find(
                      (item) => item.language === entry.language,
                    )}
                    providerConfigurationSource={
                      view.data?.providerMetadata?.find((item) => item.language === entry.language)
                        ?.configurationSource
                    }
                    root={root ?? ""}
                    disabled={view.mutating}
                    onAction={(language, action, opener) => {
                      if (action === "activate") void view.apply(language, action);
                      else if (action !== "configure")
                        setConfirmation({ language, action, opener });
                    }}
                    onSaveConfiguration={(configuration) => {
                      const current = view.data;
                      if (current === undefined) return;
                      void view.applyConfiguration(configuration.language, {
                        ...configuration,
                        revision: current.revision,
                        etag: current.etag,
                        restartRequired: true,
                        restartFields: ["settings"],
                      });
                    }}
                    t={t}
                  />,
                ]
              : [],
          )}
        </div>
      ) : null}
      {confirmation !== undefined ? (
        <div className={styles.dialogBackdrop}>
          <div
            className={styles.dialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="managed-language-confirm-title"
            aria-describedby="managed-language-confirm-description"
          >
            <div className={styles.dialogTitle} id="managed-language-confirm-title">
              {t("confirmTitle")}
            </div>
            <p className={styles.reason} id="managed-language-confirm-description">
              {t("confirmBody", { action: actionLabel(confirmation.action, t) })}
            </p>
            <div className={styles.dialogActions}>
              <button
                ref={cancelRef}
                type="button"
                className={styles.button}
                onClick={closeConfirmation}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className={`${styles.button} ${styles.danger}`}
                onClick={confirmAction}
              >
                {t("confirm", { action: actionLabel(confirmation.action, t) })}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface LanguageCardProps {
  readonly status: Extract<ManagedLspActivationResolution, { readonly ok: true }>;
  readonly configuration: ManagedLspConfigurationSummary | undefined;
  readonly health: ManagedLspProcessHealthSnapshot | undefined;
  readonly runtimeConfiguration: ManagedLspRuntimeConfiguration | undefined;
  readonly providerConfigurationSource: string | undefined;
  readonly root: string;
  readonly disabled: boolean;
  readonly onAction: (
    language: ManagedLspLanguage,
    action: ManagedLspSettingsAction,
    opener: HTMLButtonElement,
  ) => void;
  readonly t: ManagedLanguageTranslate;
  readonly onSaveConfiguration: (configuration: ManagedLspRuntimeConfiguration) => void;
}

function LanguageCard(props: LanguageCardProps): ReactNode {
  const {
    status,
    configuration,
    health,
    runtimeConfiguration,
    providerConfigurationSource,
    root,
    disabled,
    onAction,
    onSaveConfiguration,
    t,
  } = props;
  const language = languageLabel(status.language, t);
  return (
    <article className={styles.card} aria-labelledby={`managed-language-${status.language}`}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.language} id={`managed-language-${status.language}`}>
            {language}
          </div>
          <div className={styles.reason}>{reasonLabel(status.reasonCode, t)}</div>
        </div>
        <output className={styles.state} data-state={status.state}>
          <span aria-hidden="true">{stateIcon(status.state)}</span>
          {stateLabel(status.state, t)}
        </output>
      </div>
      {guidance(status.state, status.reasonCode, t)}
      <div className={styles.details}>
        <CapabilitySummary health={health} t={t} />
        <HealthSummary health={health} t={t} />
        <ConfigurationSummary
          configuration={configuration}
          runtimeConfiguration={runtimeConfiguration}
          providerConfigurationSource={providerConfigurationSource}
          t={t}
        />
      </div>
      {runtimeConfiguration === undefined ? null : (
        <RuntimeSettingsEditor
          key={`${root}:${runtimeConfiguration.language}:${runtimeConfiguration.revision.toString()}`}
          root={root}
          configuration={runtimeConfiguration}
          disabled={disabled}
          onSave={onSaveConfiguration}
          t={t}
        />
      )}
      <div className={styles.actions}>
        {actionsFor(status.state, status.reasonCode).map((action) => (
          <button
            type="button"
            key={action}
            className={`${styles.button} ${action === "activate" ? styles.primary : ""}`}
            disabled={disabled}
            aria-label={actionAria(action, language, t)}
            onClick={(event) => onAction(status.language, action, event.currentTarget)}
          >
            {actionLabel(action, t)}
          </button>
        ))}
      </div>
    </article>
  );
}

function CapabilitySummary({
  health,
  t,
}: {
  readonly health: ManagedLspProcessHealthSnapshot | undefined;
  readonly t: ManagedLanguageTranslate;
}): ReactNode {
  const operations = health?.negotiatedOperations ?? [];
  const shown = operations.slice(0, MAX_CAPABILITIES);
  return (
    <div className={styles.detail}>
      <div className={styles.detailTitle}>{t("capabilities")}</div>
      {shown.length === 0 ? <div className={styles.meta}>{t("noCapabilities")}</div> : null}
      <ul className={styles.capabilities}>
        {shown.map((operation, index) => (
          <li
            className={styles.capability}
            data-testid="managed-lsp-capability"
            key={`${operation}-${index.toString()}`}
          >
            {operation}
          </li>
        ))}
      </ul>
      {operations.length > shown.length ? (
        <div className={styles.meta}>
          {t("moreCapabilities", { count: operations.length - shown.length })}
        </div>
      ) : null}
    </div>
  );
}

function HealthSummary({
  health,
  t,
}: {
  readonly health: ManagedLspProcessHealthSnapshot | undefined;
  readonly t: ManagedLanguageTranslate;
}): ReactNode {
  return (
    <div className={styles.detail}>
      <div className={styles.detailTitle}>{t("health")}</div>
      <div className={styles.meta}>
        {health === undefined
          ? t("healthUnavailable")
          : t("healthSummary", {
              status: health.status,
              success: health.successCount,
              failures: health.failureCount + health.timeoutCount,
              latency: health.latency.maximumMs,
            })}
      </div>
    </div>
  );
}

function ConfigurationSummary({
  configuration,
  runtimeConfiguration,
  providerConfigurationSource,
  t,
}: {
  readonly configuration: ManagedLspConfigurationSummary | undefined;
  readonly runtimeConfiguration: ManagedLspRuntimeConfiguration | undefined;
  readonly providerConfigurationSource: string | undefined;
  readonly t: ManagedLanguageTranslate;
}): ReactNode {
  const source = configuration?.provenance?.settings;
  return (
    <div className={styles.detail}>
      <div className={styles.detailTitle}>{t("configuration")}</div>
      <div className={styles.meta}>
        {configuration?.configured === true ? t("configured") : t("notConfigured")}
      </div>
      {runtimeConfiguration === undefined ? null : (
        <div className={styles.meta}>{runtimeSettingsSummary(runtimeConfiguration, t)}</div>
      )}
      {source !== undefined ? (
        <div className={styles.meta}>{t("source", { source: sourceLabel(source, t) })}</div>
      ) : null}
      {providerConfigurationSource === undefined ? null : (
        <div className={styles.meta}>
          {t("providerConfigurationSource", { source: providerConfigurationSource })}
        </div>
      )}
      {configuration?.restartRequired === true ? (
        <div className={styles.meta}>
          {t("restartImpact", {
            fields: configuration.restartFields
              .map((field) => t(field === "runtime" ? "restartRuntime" : "restartSettings"))
              .join(", "),
          })}
        </div>
      ) : null}
    </div>
  );
}

function runtimeSettingsSummary(
  configuration: ManagedLspRuntimeConfiguration,
  t: ManagedLanguageTranslate,
): string {
  if (configuration.language === "python") {
    return t("pythonSettings", {
      mode: configuration.settings.typeCheckingMode,
      count: configuration.settings.extraPaths.length,
      interpreter: configuration.settings.interpreter.runtimeId,
      venv: configuration.settings.venv?.runtimeId ?? t("valueDefault"),
      precedence: configuration.settings.configurationPrecedence.join(" > "),
    });
  }
  if (configuration.language === "go") {
    return t("goSettings", {
      staticcheck: t(configuration.settings.staticcheck ? "valueEnabled" : "valueDisabled"),
      count: configuration.settings.buildTags.length,
      target: `${configuration.settings.target.goos}/${configuration.settings.target.goarch}`,
    });
  }
  if (configuration.language === "shell") {
    return t("shellSettings", {
      dialect: configuration.settings.dialect,
      shellcheck: configuration.settings.shellCheck.mode,
      severity: configuration.settings.shellCheck.severity,
      exclusions: configuration.settings.shellCheck.excludedCodes.length,
      paths: configuration.settings.shellCheck.includePaths.length,
    });
  }
  if (configuration.language === "java") {
    return t("javaSettings", {
      source: configuration.settings.sourceLevel,
      target: configuration.settings.targetLevel,
      count: configuration.settings.projectRoots.length,
    });
  }
  return t("rustSettings", {
    count: configuration.settings.features.length,
    target: configuration.settings.target ?? t("valueDefault"),
    metadata: configuration.settings.cargoMetadata,
  });
}

type RuntimeDraft =
  | { readonly language: "python"; readonly typeCheckingMode: "basic" | "standard" | "strict" }
  | { readonly language: "go"; readonly staticcheck: boolean }
  | { readonly language: "shell"; readonly dialect: "posix" | "bash" }
  | {
      readonly language: "java";
      readonly sourceLevel: "8" | "11" | "17" | "21" | "25";
      readonly targetLevel: "8" | "11" | "17" | "21" | "25";
    }
  | { readonly language: "rust"; readonly target: string };

const runtimeDrafts = new Map<string, RuntimeDraft>();

function RuntimeSettingsEditor({
  root,
  configuration,
  disabled,
  onSave,
  t,
}: {
  readonly root: string;
  readonly configuration: ManagedLspRuntimeConfiguration;
  readonly disabled: boolean;
  readonly onSave: (configuration: ManagedLspRuntimeConfiguration) => void;
  readonly t: ManagedLanguageTranslate;
}): ReactNode {
  const identity = `${root}\0${configuration.language}`;
  const initial = draftFromConfiguration(configuration);
  const [draft, setDraft] = useState<RuntimeDraft>(runtimeDrafts.get(identity) ?? initial);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const error =
    draft.language === "rust" && !validRustTarget(draft.target) ? t("invalidTarget") : "";
  const update = (next: RuntimeDraft): void => {
    runtimeDrafts.set(identity, next);
    setDraft(next);
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || error.length > 0) return;
        onSave(configurationFromDraft(configuration, draft));
      }}
    >
      {runtimeDraftControl(draft, update, t)}
      {dirty ? <div className={styles.meta}>{t("unsaved")}</div> : null}
      {error.length > 0 ? (
        <div className={styles.reason} role="alert">
          {error}
        </div>
      ) : null}
      <div className={styles.actions}>
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={disabled || !dirty || error.length > 0}
        >
          {t("saveSettings")}
        </button>
      </div>
    </form>
  );
}

function runtimeDraftControl(
  draft: RuntimeDraft,
  update: (draft: RuntimeDraft) => void,
  t: ManagedLanguageTranslate,
): ReactNode {
  if (draft.language === "python") {
    return (
      <label className={styles.field}>
        {t("editTypeChecking")}
        <select
          className={styles.input}
          value={draft.typeCheckingMode}
          onChange={(event) =>
            update({
              language: "python",
              typeCheckingMode: event.target.value as "basic" | "standard" | "strict",
            })
          }
        >
          <option value="basic">basic</option>
          <option value="standard">standard</option>
          <option value="strict">strict</option>
        </select>
      </label>
    );
  }
  if (draft.language === "go") {
    return (
      <label className={styles.checkField}>
        <input
          type="checkbox"
          checked={draft.staticcheck}
          onChange={(event) => update({ language: "go", staticcheck: event.target.checked })}
        />
        {t("editStaticcheck")}
      </label>
    );
  }
  if (draft.language === "shell") {
    return selectDraft(
      "editDialect",
      draft.dialect,
      ["posix", "bash"],
      (value) => {
        update({ language: "shell", dialect: value as "posix" | "bash" });
      },
      t,
    );
  }
  if (draft.language === "java") return javaDraftControls(draft, update, t);
  return (
    <label className={styles.field}>
      {t("editRustTarget")}
      <input
        className={styles.input}
        value={draft.target}
        maxLength={128}
        aria-invalid={!validRustTarget(draft.target)}
        onChange={(event) => update({ language: "rust", target: event.target.value })}
      />
    </label>
  );
}

function javaDraftControls(
  draft: Extract<RuntimeDraft, { readonly language: "java" }>,
  update: (draft: RuntimeDraft) => void,
  t: ManagedLanguageTranslate,
): ReactNode {
  const levels = ["8", "11", "17", "21", "25"] as const;
  return (
    <>
      {selectDraft(
        "editJavaSource",
        draft.sourceLevel,
        levels,
        (sourceLevel) => {
          update({ ...draft, sourceLevel });
        },
        t,
      )}
      {selectDraft(
        "editJavaTarget",
        draft.targetLevel,
        levels,
        (targetLevel) => {
          update({ ...draft, targetLevel });
        },
        t,
      )}
    </>
  );
}

function selectDraft<T extends string>(
  label: "editDialect" | "editJavaSource" | "editJavaTarget",
  value: T,
  values: readonly T[],
  onChange: (value: T) => void,
  t: ManagedLanguageTranslate,
): ReactNode {
  return (
    <label className={styles.field}>
      {t(label)}
      <select
        className={styles.input}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {values.map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function draftFromConfiguration(configuration: ManagedLspRuntimeConfiguration): RuntimeDraft {
  if (configuration.language === "python") {
    return { language: "python", typeCheckingMode: configuration.settings.typeCheckingMode };
  }
  if (configuration.language === "go") {
    return { language: "go", staticcheck: configuration.settings.staticcheck };
  }
  if (configuration.language === "shell") {
    return { language: "shell", dialect: configuration.settings.dialect };
  }
  if (configuration.language === "java") {
    return {
      language: "java",
      sourceLevel: configuration.settings.sourceLevel,
      targetLevel: configuration.settings.targetLevel,
    };
  }
  return { language: "rust", target: configuration.settings.target ?? "" };
}

function configurationFromDraft(
  configuration: ManagedLspRuntimeConfiguration,
  draft: RuntimeDraft,
): ManagedLspRuntimeConfiguration {
  if (configuration.language === "python" && draft.language === "python") {
    return {
      ...configuration,
      settings: { ...configuration.settings, typeCheckingMode: draft.typeCheckingMode },
    };
  }
  if (configuration.language === "go" && draft.language === "go") {
    return {
      ...configuration,
      settings: { ...configuration.settings, staticcheck: draft.staticcheck },
    };
  }
  if (configuration.language === "shell" && draft.language === "shell") {
    return { ...configuration, settings: { ...configuration.settings, dialect: draft.dialect } };
  }
  if (configuration.language === "java" && draft.language === "java") {
    return {
      ...configuration,
      settings: {
        ...configuration.settings,
        sourceLevel: draft.sourceLevel,
        targetLevel: draft.targetLevel,
      },
    };
  }
  if (configuration.language === "rust" && draft.language === "rust") {
    return {
      ...configuration,
      settings: { ...configuration.settings, target: draft.target || null },
    };
  }
  return configuration;
}

function validRustTarget(value: string): boolean {
  return value.length <= 128 && (value.length === 0 || /^[a-zA-Z0-9._-]+$/u.test(value));
}

function actionsFor(
  state: ManagedLspEffectiveState,
  reason: ManagedLspActivationReasonCode,
): readonly ManagedLspSettingsAction[] {
  if (
    state === "disabledByPolicy" ||
    state === "notProvisioned" ||
    reason === "STATE_UNAVAILABLE"
  ) {
    return ["reset"];
  }
  if (state === "disabled" || state === "available") return ["activate", "reset"];
  if (state === "starting") return ["deactivate", "reset"];
  return ["restart", "deactivate", "reset"];
}

function guidance(
  state: ManagedLspEffectiveState,
  reason: ManagedLspActivationReasonCode,
  t: ManagedLanguageTranslate,
): ReactNode {
  if (state === "disabledByPolicy") return <p className={styles.reason}>{t("guidancePolicy")}</p>;
  if (state === "notProvisioned") {
    return <p className={styles.reason}>{t("guidanceProvisioning")}</p>;
  }
  return reason === "STATE_UNAVAILABLE" ? (
    <p className={styles.reason}>{t("guidanceUnavailable")}</p>
  ) : null;
}

function actionAria(
  action: ManagedLspSettingsAction,
  language: string,
  t: ManagedLanguageTranslate,
): string {
  if (action === "activate") return t("enabled", { language });
  if (action === "deactivate") return t("disabled", { language });
  if (action === "restart") return t("restart", { language });
  return t("reset", { language });
}

function actionLabel(action: ManagedLspSettingsAction, t: ManagedLanguageTranslate): string {
  if (action === "activate") return t("actionEnable");
  if (action === "deactivate") return t("actionDisable");
  if (action === "configure") return t("saveSettings");
  if (action === "restart") return t("actionRestart");
  return t("actionReset");
}

function stateIcon(state: ManagedLspEffectiveState): string {
  if (state === "active" || state === "available") return "✓";
  if (state === "starting") return "…";
  if (state === "degraded" || state === "restartRequired") return "!";
  if (state === "unhealthy" || state === "disabledByPolicy") return "×";
  return "○";
}

function stateLabel(state: ManagedLspEffectiveState, t: ManagedLanguageTranslate): string {
  const keys: Readonly<Record<ManagedLspEffectiveState, Parameters<typeof t>[0]>> = {
    disabled: "stateDisabled",
    disabledByPolicy: "stateDisabledByPolicy",
    notProvisioned: "stateNotProvisioned",
    available: "stateAvailable",
    starting: "stateStarting",
    active: "stateActive",
    degraded: "stateDegraded",
    unhealthy: "stateUnhealthy",
    restartRequired: "stateRestartRequired",
  };
  return t(keys[state]);
}

function languageLabel(language: ManagedLspLanguage, t: ManagedLanguageTranslate): string {
  const keys: Readonly<Record<ManagedLspLanguage, Parameters<typeof t>[0]>> = {
    python: "languagePython",
    go: "languageGo",
    shell: "languageShell",
    java: "languageJava",
    rust: "languageRust",
  };
  return t(keys[language]);
}

function reasonLabel(reason: ManagedLspActivationReasonCode, t: ManagedLanguageTranslate): string {
  const keys: Readonly<Record<ManagedLspActivationReasonCode, Parameters<typeof t>[0]>> = {
    PRODUCT_UNSUPPORTED: "reasonProductUnsupported",
    POLICY_DENIED: "reasonPolicyDenied",
    LEGACY_ENV_DISABLED: "reasonLegacyDisabled",
    NOT_PROVISIONED: "reasonNotProvisioned",
    WORKSPACE_DISABLED: "reasonWorkspaceDisabled",
    WORKSPACE_ACTIVATION_UNSET: "reasonWorkspaceUnset",
    AVAILABLE: "reasonAvailable",
    STARTING: "reasonStarting",
    NEGOTIATED_CAPABILITY_MISSING: "reasonCapabilityMissing",
    RUNTIME_HEALTH_UNKNOWN: "reasonHealthUnknown",
    RUNTIME_DEGRADED: "reasonDegraded",
    RUNTIME_UNHEALTHY: "reasonUnhealthy",
    RESTART_REQUIRED: "reasonRestartRequired",
    ACTIVE: "reasonActive",
    STATE_UNAVAILABLE: "reasonStateUnavailable",
    INVALID_INPUT: "reasonInvalid",
  };
  return t(keys[reason]);
}

function sourceLabel(
  source: "builtInDefault" | "operatorProvisioning" | "workspace",
  t: ManagedLanguageTranslate,
): string {
  if (source === "workspace") return t("sourceWorkspace");
  if (source === "operatorProvisioning") return t("sourceOperatorProvisioning");
  return t("sourceBuiltInDefault");
}

function issueCopy(issue: "load" | "mutation", t: ManagedLanguageTranslate): string {
  return issue === "load" ? t("loadFailed") : t("mutationFailed");
}

function announcement(value: string, t: ManagedLanguageTranslate): string {
  const [action, language] = value.split(":");
  if (action === undefined || language === undefined) return "";
  return t("announcedApplied", {
    action: actionLabel(action as ManagedLspSettingsAction, t),
    language: languageLabel(language as ManagedLspLanguage, t),
  });
}
