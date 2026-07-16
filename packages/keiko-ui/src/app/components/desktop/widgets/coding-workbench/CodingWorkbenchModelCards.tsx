import type { ReactNode } from "react";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchCodexSubscriptionProfile,
  CodingWorkbenchRuntimePreference,
} from "@oscharko-dev/keiko-contracts";
import {
  useCodingWorkbenchTranslate as useTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import {
  modelSourceLabel,
  resourceStatusLabel,
  resourceStatusSymbol,
  resourceTone,
} from "./codingWorkbenchLabels";
import { PanelTitle } from "./CodingWorkbenchSections";
import styles from "./CodingWorkbenchWindow.module.css";

interface ModelRuntimeStatusProps {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: Pick<
    CodingWorkbenchRuntimeActions,
    "setRuntimePreference" | "prepareCodexSetup" | "refreshProfile" | "refreshSource"
  >;
  readonly locked: boolean;
}

export function ModelRuntimeStatus({ state, actions, locked }: ModelRuntimeStatusProps): ReactNode {
  const t = useTranslate();
  const selected = state.runtimePreference;
  return (
    <section className={styles.card} aria-labelledby="coding-workbench-source-title">
      <PanelTitle eyebrow={t("codingWorkbench.source.eyebrow")} id="coding-workbench-source-title">
        {t("codingWorkbench.source.title")}
      </PanelTitle>
      <div
        className={styles.sourceGrid}
        role="radiogroup"
        aria-label={t("codingWorkbench.source.group")}
      >
        <SourceCard
          preference="managed-gateway"
          selected={selected === "managed-gateway"}
          locked={locked}
          status={selected === "managed-gateway" ? state.source.status : "idle"}
          label={t("codingWorkbench.source.gateway.label")}
          detail={t("codingWorkbench.source.gateway.detail")}
          onSelect={actions.setRuntimePreference}
        />
        <SourceCard
          preference="codex-subscription"
          selected={selected === "codex-subscription"}
          locked={locked}
          status={selected === "codex-subscription" ? state.source.status : "idle"}
          label={t("codingWorkbench.source.codex.label")}
          detail={t("codingWorkbench.source.codex.detail")}
          onSelect={actions.setRuntimePreference}
        />
      </div>
      <SourceTruth state={state} onRetry={actions.refreshSource} />
      {selected === "codex-subscription" ? (
        <AuthTruth
          state={state}
          onRetry={actions.refreshProfile}
          onPrepare={actions.prepareCodexSetup}
        />
      ) : null}
    </section>
  );
}

function SourceCard({
  preference,
  selected,
  locked,
  status,
  label,
  detail,
  onSelect,
}: {
  readonly preference: CodingWorkbenchRuntimePreference;
  readonly selected: boolean;
  readonly locked: boolean;
  readonly status: CodingWorkbenchRuntimeState["source"]["status"];
  readonly label: string;
  readonly detail: string;
  readonly onSelect: (preference: CodingWorkbenchRuntimePreference) => void;
}): ReactNode {
  const t = useTranslate();
  const id = `coding-workbench-source-${preference}`;
  return (
    <div
      className={styles.sourceCard}
      data-selected={selected ? "true" : "false"}
      data-status={status}
    >
      <input
        id={id}
        type="radio"
        name="coding-workbench-source"
        checked={selected}
        disabled={locked}
        onChange={() => onSelect(preference)}
      />
      <label htmlFor={id} className={styles.sourceText}>
        <span className={styles.sourceName}>{label}</span>
        <span className={styles.sourceDetail}>{detail}</span>
      </label>
      {selected ? (
        <span className={styles.statusBadge} data-tone={resourceTone(status)}>
          <span aria-hidden="true">{resourceStatusSymbol(status)}</span>
          {resourceStatusLabel(status, t)}
        </span>
      ) : null}
    </div>
  );
}

function SourceTruth({
  state,
  onRetry,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly onRetry: () => Promise<void>;
}): ReactNode {
  const t = useTranslate();
  const source = state.source.value;
  if (source === null) return null;
  return (
    <div className={styles.truthRow} data-status={source.available ? "ready" : "unavailable"}>
      <div>
        <p className={styles.truthLabel}>{t("codingWorkbench.source.confirmedLabel")}</p>
        <p className={styles.truthValue}>
          {t("codingWorkbench.source.confirmedValue", {
            source: modelSourceLabel(source.modelSource, t),
            status: source.available
              ? t("codingWorkbench.status.available")
              : t("codingWorkbench.status.unavailable"),
          })}
        </p>
      </div>
      {!source.available ? (
        <button className={styles.button} type="button" onClick={() => void onRetry()}>
          {t("codingWorkbench.source.retry")}
        </button>
      ) : null}
    </div>
  );
}

function AuthTruth({
  state,
  onRetry,
  onPrepare,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly onRetry: () => Promise<void>;
  readonly onPrepare?: ((method: CodingWorkbenchCodexAuthMethod) => Promise<void>) | undefined;
}): ReactNode {
  const t = useTranslate();
  const profile = state.profile.value;
  const status = profile?.status ?? state.profile.status;
  const connected = profile?.status === "connected";
  return (
    <>
      <div className={styles.truthRow} data-status={connected ? "ready" : state.profile.status}>
        <div>
          <p className={styles.truthLabel}>{t("codingWorkbench.auth.label")}</p>
          <p className={styles.truthValue}>{authLabel(status, t)}</p>
        </div>
        {!connected && state.profile.status !== "loading" ? (
          <button className={styles.button} type="button" onClick={() => void onRetry()}>
            {t("codingWorkbench.auth.refresh")}
          </button>
        ) : null}
      </div>
      {profile !== null && actionableAuthStatus(profile.status) ? (
        <CodexSetup state={state} profile={profile} onPrepare={onPrepare} />
      ) : null}
    </>
  );
}

function CodexSetup({
  state,
  profile,
  onPrepare,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly profile: CodingWorkbenchCodexSubscriptionProfile;
  readonly onPrepare?: ((method: CodingWorkbenchCodexAuthMethod) => Promise<void>) | undefined;
}): ReactNode {
  const t = useTranslate();
  return (
    <div className={styles.setupPanel}>
      <p className={styles.truthLabel}>{t("codingWorkbench.auth.setupMethods")}</p>
      <SetupMethods profile={profile} state={state} onPrepare={onPrepare} t={t} />
      <SetupStatus status={state.codexSetup.status} t={t} />
      <SetupPlan plan={state.codexSetup.value} t={t} />
    </div>
  );
}

interface SetupMethodsProps {
  readonly profile: CodingWorkbenchCodexSubscriptionProfile;
  readonly state: CodingWorkbenchRuntimeState;
  readonly onPrepare?: ((method: CodingWorkbenchCodexAuthMethod) => Promise<void>) | undefined;
  readonly t: CodingWorkbenchTranslate;
}

function SetupMethods({ profile, state, onPrepare, t }: SetupMethodsProps): ReactNode {
  const methods = supportedAuthMethods(profile);
  if (methods.length === 0)
    return <p className={styles.helpText}>{t("codingWorkbench.auth.noMethod")}</p>;
  const busy = state.codexSetup.status === "loading";
  return (
    <div className={styles.setupActions} aria-label={t("codingWorkbench.auth.setupMethodsGroup")}>
      {methods.map((method) => (
        <button
          key={method}
          className={styles.button}
          type="button"
          disabled={busy || onPrepare === undefined}
          onClick={() => void onPrepare?.(method)}
        >
          {busy
            ? t("codingWorkbench.auth.preparing")
            : t("codingWorkbench.auth.prepare", { method: authMethodLabel(method, t) })}
        </button>
      ))}
    </div>
  );
}

function SetupStatus({
  status,
  t,
}: {
  readonly status: CodingWorkbenchRuntimeState["codexSetup"]["status"];
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  return status === "error" || status === "unavailable" ? (
    <p className={styles.setupStatus}>{t("codingWorkbench.auth.setupUnavailable")}</p>
  ) : null;
}

function SetupPlan({
  plan,
  t,
}: {
  readonly plan: CodingWorkbenchRuntimeState["codexSetup"]["value"];
  readonly t: CodingWorkbenchTranslate;
}): ReactNode {
  if (plan === null) return null;
  return (
    <div className={styles.setupPlan}>
      <p className={styles.truthValue}>{t("codingWorkbench.auth.planReady")}</p>
      <p className={styles.helpText}>
        {t("codingWorkbench.auth.planDetail", {
          method: authMethodLabel(plan.method, t),
          command: plan.commandLabel,
          secretInput: plan.requiresSecretInput
            ? t("codingWorkbench.auth.secretRequired")
            : t("codingWorkbench.auth.secretNotRequired"),
        })}
      </p>
      <p className={styles.helpText}>{t("codingWorkbench.auth.planHelp")}</p>
    </div>
  );
}

function actionableAuthStatus(status: CodingWorkbenchCodexSubscriptionProfile["status"]): boolean {
  return (
    status === "missing" ||
    status === "expired" ||
    status === "revoked" ||
    status === "failed-login"
  );
}

function supportedAuthMethods(
  profile: CodingWorkbenchCodexSubscriptionProfile,
): readonly CodingWorkbenchCodexAuthMethod[] {
  return [
    ...(profile.supportsBrowserLogin ? (["chatgpt-browser-login"] as const) : []),
    ...(profile.supportsDeviceCode ? (["chatgpt-device-code"] as const) : []),
    ...(profile.supportsAccessToken ? (["codex-access-token"] as const) : []),
  ];
}

function authMethodLabel(
  method: CodingWorkbenchCodexAuthMethod,
  t: CodingWorkbenchTranslate,
): string {
  if (method === "chatgpt-browser-login") return t("codingWorkbench.auth.method.browser");
  if (method === "chatgpt-device-code") return t("codingWorkbench.auth.method.deviceCode");
  return t("codingWorkbench.auth.method.accessToken");
}

function authLabel(status: string, t: CodingWorkbenchTranslate): string {
  if (status === "connected") return t("codingWorkbench.auth.status.connected");
  if (status === "loading") return t("codingWorkbench.status.checking");
  if (status === "missing") return t("codingWorkbench.auth.status.required");
  if (status === "expired") return t("codingWorkbench.auth.status.expired");
  if (status === "revoked") return t("codingWorkbench.auth.status.revoked");
  if (status === "failed-login") return t("codingWorkbench.auth.status.failedLogin");
  if (status === "disabled-by-deployment")
    return t("codingWorkbench.auth.status.disabledDeployment");
  if (status === "unsupported-headless")
    return t("codingWorkbench.auth.status.unavailableEnvironment");
  if (status === "redistribution-unapproved")
    return t("codingWorkbench.auth.status.unavailableRelease");
  return t("codingWorkbench.auth.status.unavailable");
}
