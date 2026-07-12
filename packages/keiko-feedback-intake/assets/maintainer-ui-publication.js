import { element, text } from "./maintainer-ui-dom.js";
import { publicationCopy as copy } from "./maintainer-ui-copy.js";

const PREPARATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FAILURE_COPY = {
  "permission-denied": "permissionDenied",
  "validation-error": "validationError",
  "rate-limited": "rateLimited",
  "repository-unavailable": "repositoryUnavailable",
  "provider-unavailable": "providerUnavailable",
  "duplicate-candidate": "duplicateCandidate",
  "target-policy-drift": "targetPolicyDrift",
  "projection-drift": "projectionDrift",
  "payload-private": "payloadPrivate",
  "payload-expired": "payloadExpired",
  "cas-mismatch": "conflict",
  "idempotency-mismatch": "conflict",
  "retry-exhausted": "manual",
  "lease-expired": "manual",
  "ambiguous-reconciliation": "manual",
  "manual-reconciliation-required": "manualReconciliation",
  "manual-remediation-required": "manualRemediation",
};

export function publicationEnabled(session) {
  return (
    session?.permissions.includes("feedback.review") === true &&
    session.permissions.includes("feedback.publish") &&
    Array.isArray(session.publicationTargets)
  );
}

function requestBody(action, detail, publication) {
  const idempotencyKey = crypto.randomUUID().replaceAll("-", "");
  if (action === "prepare-publication") {
    return {
      action,
      expectedVersion: detail.version,
      targetKey: publication.targetKey,
      idempotencyKey,
    };
  }
  return {
    action,
    preparationId: publication.status.preparationId,
    expectedProjectionDigest: publication.status.projectionDigest,
    expectedTargetPolicyDigest: publication.status.targetPolicyDigest,
    idempotencyKey,
  };
}

function currentPreview(prepared) {
  return {
    status: prepared.status,
    preparationId: prepared.preparationId,
    projectionDigest: prepared.projectionDigest,
    targetPolicyDigest: prepared.targetPolicyDigest,
    title: prepared.title,
    body: prepared.body,
    targetDisplay: prepared.targetDisplay,
  };
}

function safePreparation(status) {
  return (
    (status.status === "prepared" || status.status === "approved") &&
    typeof status.preparationId === "string" &&
    PREPARATION_ID.test(status.preparationId)
  );
}

function safeLink(linkage) {
  try {
    const url = new URL(linkage.issueUrl);
    const issuePath = /^\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}\/issues\/[1-9][0-9]*$/u;
    return url.origin === "https://github.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      issuePath.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function publicationError(error) {
  if (!(error instanceof Error)) return "failed";
  if (error.message === "forbidden") return "permissionDenied";
  if (error.message === "stale" || error.message === "conflict") return "conflict";
  if (error.message === "rateLimited") return "rateLimited";
  if (error.message === "unavailable") return "unavailable";
  return "failed";
}

function targetLabel(target) {
  const labels = target.labels.length ? ` · ${target.labels.join(", ")}` : "";
  return `${target.owner}/${target.repository}${labels}`;
}

function statusMessage(status) {
  const messages = {
    prepared: "prepared",
    approved: "approved",
    retryable: "retryable",
    "may-have-committed": "mayHaveCommitted",
    "manual-reconciliation": "manualReconciliation",
    "manual-remediation": "manualRemediation",
    succeeded: "succeeded",
    "cancelled-private": "cancelled",
  };
  return copy(messages[status.status]) || copy("failed");
}

function previewNode(preview) {
  const target = preview.targetDisplay;
  const values = [
    [copy("target"), `${target.owner}/${target.repository}`],
    [copy("labels"), target.labels.join(", ") || "—"],
    [copy("labelPolicy"), target.labelPolicyVersion],
    [copy("targetPolicy"), target.targetPolicyVersion],
  ];
  return element(
    "section",
    { className: "mq-publication-preview", "aria-labelledby": "mq-preview" },
    [
      element("h4", { id: "mq-preview", textContent: copy("preview") }),
      element("h5", { textContent: copy("issueTitle") }),
      element("pre", { className: "mq-payload", textContent: preview.title }),
      element("h5", { textContent: copy("issueBody") }),
      element("pre", { className: "mq-payload", textContent: preview.body }),
      element("h5", { textContent: copy("targetDetails") }),
      element(
        "dl",
        { className: "mq-meta mq-publication-meta" },
        values.map(([label, value]) =>
          element("div", {}, [
            element("dt", { className: "mq-label", textContent: label }),
            element("dd", { textContent: value }),
          ]),
        ),
      ),
      element("p", { className: "mq-publication-warning", textContent: copy("warning") }),
    ],
  );
}

export function createPublicationUi(options) {
  const {
    state,
    request,
    button,
    notice,
    setBusy,
    rerender,
    isCurrent,
    focusResult,
    onSessionExpired,
  } = options;
  const targets = () => state.session.publicationTargets;
  const update = (publication) => {
    state.publication = publication;
    rerender();
  };

  async function load(detail, generation, signal) {
    if (!publicationEnabled(state.session) || !isCurrent(detail.itemId, generation)) return;
    const current = state.publication || {};
    update({ ...current, phase: "loading" });
    try {
      const status = await request(`reviews/${detail.itemId}/publication/status`, { signal });
      if (!isCurrent(detail.itemId, generation)) return;
      let preview;
      if (safePreparation(status)) {
        preview = await request(
          `reviews/${detail.itemId}/publication/preview?preparationId=${encodeURIComponent(status.preparationId)}`,
          { signal },
        );
        if (!isCurrent(detail.itemId, generation)) return;
      }
      update({ phase: "ready", status, preview, targetKey: current.targetKey });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof Error && error.message === "session") {
        setBusy(false);
        onSessionExpired();
        return;
      }
      if (isCurrent(detail.itemId, generation))
        update({ phase: "error", error: publicationError(error) });
    }
  }

  async function submit(action, detail, generation, event) {
    event.preventDefault();
    const publication = state.publication;
    if (!isCurrent(detail.itemId, generation) || state.busy || publication?.status === undefined)
      return;
    if (action === "cancel-publication-route-private" && !event.currentTarget.reportValidity())
      return;
    try {
      setBusy(true);
      const path =
        action === "prepare-publication"
          ? "prepare"
          : action === "approve-publication"
            ? "approve"
            : "cancel-route-private";
      const result = await request(`reviews/${detail.itemId}/publication/${path}`, {
        method: "POST",
        signal: state.detailAbort?.signal,
        headers: {
          "Content-Type": "application/json",
          "keiko-feedback-csrf": state.session.csrfToken,
        },
        body: JSON.stringify(requestBody(action, detail, publication)),
      });
      if (!isCurrent(detail.itemId, generation)) return;
      if (action === "prepare-publication" && result.status === "prepared") {
        update({
          phase: "ready",
          status: result,
          preview: currentPreview(result),
          targetKey: publication.targetKey,
        });
      } else {
        await load(detail, generation, state.detailAbort?.signal);
      }
      focusResult();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof Error && error.message === "session") {
        setBusy(false);
        onSessionExpired();
        return;
      }
      if (isCurrent(detail.itemId, generation)) {
        update({ ...publication, phase: "error", error: publicationError(error) });
        focusResult();
      }
    } finally {
      setBusy(false);
    }
  }

  function prepareForm(detail, generation, publication) {
    const available = targets();
    if (available.length === 0) return notice(copy("noTargets"), "warning");
    const selectedKey = publication.targetKey || available[0].targetKey;
    if (publication.targetKey !== selectedKey)
      state.publication = { ...publication, targetKey: selectedKey };
    const target =
      available.length === 1 ? null : element("select", { id: "mq-publication-target" });
    if (target !== null) {
      available.forEach((candidate) =>
        target.append(
          element("option", { value: candidate.targetKey, textContent: targetLabel(candidate) }),
        ),
      );
      target.value = selectedKey;
      target.addEventListener("change", () => {
        state.publication = { ...state.publication, targetKey: target.value };
      });
    }
    const form = element("form", { className: "mq-action" }, [
      element("h3", { textContent: copy("prepare") }),
      element("p", { textContent: copy("prepareHelp") }),
      ...(target === null
        ? [element("p", { className: "mq-muted", textContent: targetLabel(available[0]) })]
        : [element("label", { htmlFor: target.id, textContent: copy("target") }, [target])]),
      button(copy("prepare"), undefined, "mq-button--primary", "submit"),
    ]);
    form.addEventListener(
      "submit",
      (event) => void submit("prepare-publication", detail, generation, event),
    );
    return form;
  }

  function preparedActions(detail, generation, publication) {
    const approval = element("form", { className: "mq-action" }, [
      element("h3", { textContent: copy("approve") }),
      element("p", { textContent: copy("approveHelp") }),
      button(copy("approve"), undefined, "mq-button--primary", "submit"),
    ]);
    approval.addEventListener(
      "submit",
      (event) => void submit("approve-publication", detail, generation, event),
    );
    const confirmation = element("input", {
      id: "mq-publication-cancel-confirm",
      type: "checkbox",
      required: true,
    });
    const cancel = element("form", { className: "mq-action mq-action--danger" }, [
      element("h3", { textContent: copy("cancel") }),
      element("p", { textContent: copy("cancelHelp") }),
      element("label", { className: "mq-confirm", htmlFor: confirmation.id }, [
        confirmation,
        text(copy("cancelConfirm")),
      ]),
      button(copy("cancel"), undefined, "mq-button--danger", "submit"),
    ]);
    cancel.addEventListener(
      "submit",
      (event) => void submit("cancel-publication-route-private", detail, generation, event),
    );
    return element("div", { className: "mq-action-grid" }, [approval, cancel]);
  }

  function render(detail, generation) {
    if (!publicationEnabled(state.session)) return null;
    const publication = state.publication;
    const content = [element("h3", { id: "mq-publication-heading", textContent: copy("title") })];
    if (publication === null || publication?.phase === "loading")
      content.push(notice(copy("loading")));
    else if (publication.phase === "error") {
      const error = notice(copy(publication.error), "error");
      error.id = "mq-publication-result";
      error.tabIndex = -1;
      content.push(error);
    } else if (publication.status.status === "none") {
      content.push(prepareForm(detail, generation, publication));
    } else {
      content.push(
        element("p", {
          id: "mq-publication-result",
          tabIndex: "-1",
          textContent: statusMessage(publication.status),
        }),
      );
      if (publication.status.failureCode)
        content.push(
          notice(copy(FAILURE_COPY[publication.status.failureCode] || "manual"), "warning"),
        );
      if (publication.preview) content.push(previewNode(publication.preview));
      if (publication.status.status === "prepared" && publication.preview)
        content.push(preparedActions(detail, generation, publication));
      const href = publication.status.linkage ? safeLink(publication.status.linkage) : null;
      if (href)
        content.push(
          element("a", {
            className: "mq-button mq-button--primary",
            href,
            target: "_blank",
            rel: "noopener noreferrer",
            textContent: copy("publicLink"),
          }),
        );
    }
    const refresh = button(copy("refresh"), () => void load(detail, generation));
    refresh.id = "mq-publication-refresh";
    content.push(refresh);
    return element(
      "section",
      { className: "mq-publication mq-stack", "aria-labelledby": "mq-publication-heading" },
      content,
    );
  }

  return { load, render };
}
