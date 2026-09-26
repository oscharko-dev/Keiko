import type { ReactNode } from "react";
import type {
  CodingWorkbenchCodexAuthMethod,
  CodingWorkbenchCodexSubscriptionProfile,
} from "@oscharko-dev/keiko-contracts";
import {
  useCodingWorkbenchTranslate as useTranslate,
  type CodingWorkbenchTranslate,
} from "./coding-workbench-i18n";
import type { CodingWorkbenchRuntimeActions } from "@/lib/useCodingWorkbenchRuntime";
import type { CodingWorkbenchRuntimeState } from "@/lib/coding-workbench-live-state";
import { PanelTitle } from "./CodingWorkbenchSections";
import styles from "./CodingWorkbenchWindow.module.css";

// The sign-in surface for the Codex subscription source, and the ONLY renderer of
// `AuthTruth`/`CodexSetup`: the window mounts this card while the subscription source is selected
// and its authentication is not `connected`. A `ModelRuntimeStatus` panel used to render `AuthTruth`
// too, which was dead production code — the window mounts this card, not that panel — so a review of
// #3381 removed the duplicate branch and #3382 removed the unmounted panel entirely.
// An operator with a missing, expired, revoked or failed login used to see Start stay disabled with
// no explanation and no way to authenticate (audit finding, 2026-09-03). The card renders nothing
// for the managed gateway and once connected.
export function CodexSubscriptionAuthCard({
  state,
  actions,
}: {
  readonly state: CodingWorkbenchRuntimeState;
  readonly actions: Pick<CodingWorkbenchRuntimeActions, "prepareCodexSetup" | "refreshProfile">;
}): ReactNode {
  const t = useTranslate();
  if (state.runtimePreference !== "codex-subscription") return null;
  if (state.profile.value?.status === "connected") return null;
  return (
    <section
      className={styles.card}
      aria-labelledby="coding-workbench-codex-auth-title"
      data-testid="coding-workbench-codex-auth"
    >
      <PanelTitle
        eyebrow={t("codingWorkbench.source.codex.label")}
        id="coding-workbench-codex-auth-title"
      >
        {t("codingWorkbench.auth.cardTitle")}
      </PanelTitle>
      <p className={styles.helpText}>{t("codingWorkbench.auth.cardHelp")}</p>
      <AuthTruth
        state={state}
        onRetry={actions.refreshProfile}
        onPrepare={actions.prepareCodexSetup}
      />
    </section>
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
