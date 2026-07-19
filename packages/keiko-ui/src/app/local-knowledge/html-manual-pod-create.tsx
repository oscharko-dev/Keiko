"use client";

// Live HTML Manual Knowledge Pod create control (Issue #2063). Renders an "add HTML manual" button;
// on expand it collects the display name, site origin, and optional path prefix, then starts the
// governed BFF create job and polls its body-free `HtmlManualPodJob` projection, surfacing live
// crawl/index progress until the job settles. Strings go through the shared `manualPodCreate.*` /
// `manualPod.*` i18n catalog (en+de); only existing global classes are reused (no globals.css edit,
// #1300). Progress rendering + polling are shared with the refresh control. Every API call is an
// injectable seam so the flow is tested without a real network.

import { useCallback, useId, useRef, useState, type ReactNode, type SubmitEvent } from "react";
import type { HtmlManualPodCreateRequest, HtmlManualPodJob } from "@oscharko-dev/keiko-contracts";
import { getHtmlManualPodJob, startHtmlManualPodCreate } from "@/lib/local-knowledge-api";
import { useTranslate } from "@/lib/i18n";
import { formatError } from "./format-error";
import {
  ManualPodProgressView,
  useManualPodJobPolling,
  type ManualPodStateLabelKeys,
} from "./manual-pod-job-progress";

const POLL_INTERVAL_MS = 1500;

const CREATE_LABEL_KEYS: ManualPodStateLabelKeys = {
  running: "manualPodCreate.progress.running",
  succeeded: "manualPodCreate.state.succeeded",
  failed: "manualPodCreate.state.failed",
};

type Translate = ReturnType<typeof useTranslate>;
type ManualPodMessageKey = Parameters<Translate>[0];

export interface HtmlManualPodCreateProps {
  readonly startCreateImpl?: typeof startHtmlManualPodCreate;
  readonly getJobImpl?: typeof getHtmlManualPodJob;
  readonly onCreateComplete?: () => void;
  // Test seam: the live-progress poll interval (defaults to POLL_INTERVAL_MS in the product).
  readonly pollIntervalMs?: number;
}

type CreateState =
  | { readonly kind: "idle" }
  | { readonly kind: "form" }
  | { readonly kind: "active"; readonly job: HtmlManualPodJob }
  | { readonly kind: "error"; readonly message: string };

// A valid create request needs a non-empty display name and an http(s) origin. The server does the
// authoritative same-origin/SSRF validation and fails closed, so this is only a fast client guard.
function hasValidCreateInput(displayName: string, origin: string): boolean {
  return displayName.trim().length > 0 && /^https?:\/\/\S+$/u.test(origin.trim());
}

export function HtmlManualPodCreate(props: HtmlManualPodCreateProps): ReactNode {
  const t = useTranslate();
  const [state, setState] = useState<CreateState>({ kind: "idle" });
  const busyRef = useRef(false);
  const start = props.startCreateImpl ?? startHtmlManualPodCreate;
  const getJob = props.getJobImpl ?? getHtmlManualPodJob;

  const onJob = useCallback((job: HtmlManualPodJob): void => setState({ kind: "active", job }), []);
  const onError = useCallback((message: string): void => setState({ kind: "error", message }), []);
  const pollJobId =
    state.kind === "active" && state.job.state === "running" ? state.job.jobId : undefined;
  useManualPodJobPolling({
    pollJobId,
    getJob,
    onJob,
    onError,
    onComplete: props.onCreateComplete,
    intervalMs: props.pollIntervalMs ?? POLL_INTERVAL_MS,
  });

  const submit = useCallback(
    (request: HtmlManualPodCreateRequest): void => {
      if (busyRef.current) return;
      busyRef.current = true;
      void start(request)
        .then((job) => setState({ kind: "active", job }))
        .catch((error: unknown) => setState({ kind: "error", message: formatError(error) }))
        .finally(() => {
          busyRef.current = false;
        });
    },
    [start],
  );

  if (state.kind === "active") {
    return <ManualPodProgressView job={state.job} t={t} labelKeys={CREATE_LABEL_KEYS} />;
  }
  return (
    <div className="lkd-manual-create-trigger">
      {state.kind === "error" ? (
        <p className="lk-alert" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.kind === "form" ? (
        <CreateForm t={t} onSubmit={submit} onCancel={() => setState({ kind: "idle" })} />
      ) : (
        <button
          type="button"
          className="lk-btn lk-btn-ghost"
          onClick={() => setState({ kind: "form" })}
        >
          {t("manualPodCreate.button")}
        </button>
      )}
    </div>
  );
}

function Field({
  t,
  labelKey,
  placeholderKey,
  value,
  onChange,
}: {
  readonly t: Translate;
  readonly labelKey: ManualPodMessageKey;
  readonly placeholderKey: ManualPodMessageKey;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactNode {
  const id = useId();
  return (
    <label className="mc-dialog-field" htmlFor={id}>
      <span className="mc-dialog-label">{t(labelKey)}</span>
      <input
        id={id}
        className="mc-dialog-input"
        value={value}
        placeholder={t(placeholderKey)}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function CreateForm({
  t,
  onSubmit,
  onCancel,
}: {
  readonly t: Translate;
  readonly onSubmit: (request: HtmlManualPodCreateRequest) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const [displayName, setDisplayName] = useState("");
  const [origin, setOrigin] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!hasValidCreateInput(displayName, origin)) {
      setInvalid(true);
      return;
    }
    const prefix = pathPrefix.trim();
    onSubmit({
      displayName: displayName.trim(),
      origin: origin.trim(),
      pathPrefix: prefix.length > 0 ? prefix : null,
    });
  };

  return (
    <form className="lkd-manual-create-form" onSubmit={handleSubmit}>
      <span className="mc-dialog-label">{t("manualPodCreate.form.title")}</span>
      <Field
        t={t}
        labelKey="manualPodCreate.form.nameLabel"
        placeholderKey="manualPodCreate.form.namePlaceholder"
        value={displayName}
        onChange={setDisplayName}
      />
      <Field
        t={t}
        labelKey="manualPodCreate.form.originLabel"
        placeholderKey="manualPodCreate.form.originPlaceholder"
        value={origin}
        onChange={setOrigin}
      />
      <Field
        t={t}
        labelKey="manualPodCreate.form.prefixLabel"
        placeholderKey="manualPodCreate.form.prefixPlaceholder"
        value={pathPrefix}
        onChange={setPathPrefix}
      />
      {invalid ? (
        <p id={errorId} role="alert" aria-live="assertive" className="mc-dialog-error">
          {t("manualPodCreate.form.validation")}
        </p>
      ) : null}
      <div className="mc-dialog-actions">
        <button type="button" className="lk-btn lk-btn-ghost" onClick={onCancel}>
          {t("manualPodCreate.form.cancel")}
        </button>
        <button type="submit" className="lk-btn lk-btn-primary">
          {t("manualPodCreate.form.submit")}
        </button>
      </div>
    </form>
  );
}
