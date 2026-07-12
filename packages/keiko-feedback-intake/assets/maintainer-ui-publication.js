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
    const url = new globalThis.URL(linkage.issueUrl);
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

function publicationPath(action) {
  if (action === "prepare-publication") return "prepare";
  return action === "approve-publication" ? "approve" : "cancel-route-private";
}

function createPublicationContext(options) {
  return {
    ...options,
    update(publication) {
      options.state.publication = publication;
      options.rerender();
    },
  };
}

async function publicationSnapshot(context, detail, generation, signal) {
  const status = await context.request(`reviews/${detail.itemId}/publication/status`, { signal });
  if (!context.isCurrent(detail.itemId, generation)) return null;
  if (!safePreparation(status)) return { status, preview: undefined };
  const preview = await context.request(
    `reviews/${detail.itemId}/publication/preview?preparationId=${encodeURIComponent(status.preparationId)}`,
    { signal },
  );
  return context.isCurrent(detail.itemId, generation) ? { status, preview } : null;
}

function handlePublicationError(context, error, detail, generation, publication, focus) {
  if (error instanceof globalThis.DOMException && error.name === "AbortError") return;
  if (error instanceof Error && error.message === "session") {
    context.setBusy(false);
    context.onSessionExpired();
    return;
  }
  if (!context.isCurrent(detail.itemId, generation)) return;
  context.update({ ...publication, phase: "error", error: publicationError(error) });
  if (focus) context.focusResult();
}

async function loadPublication(context, detail, generation, signal) {
  if (!publicationEnabled(context.state.session) || !context.isCurrent(detail.itemId, generation))
    return;
  const publication = context.state.publication || {};
  context.update({ ...publication, phase: "loading" });
  try {
    const snapshot = await publicationSnapshot(context, detail, generation, signal);
    if (snapshot) context.update({ phase: "ready", ...snapshot, targetKey: publication.targetKey });
  } catch (error) {
    handlePublicationError(context, error, detail, generation, publication, false);
  }
}

function canSubmitPublication(context, action, detail, generation, event, publication) {
  if (
    !context.isCurrent(detail.itemId, generation) ||
    context.state.busy ||
    publication?.status === undefined
  )
    return false;
  return action !== "cancel-publication-route-private" || event.currentTarget.reportValidity();
}

function publicationRequest(context, action, detail, publication) {
  return context.request(`reviews/${detail.itemId}/publication/${publicationPath(action)}`, {
    method: "POST",
    signal: context.state.detailAbort?.signal,
    headers: {
      "Content-Type": "application/json",
      "keiko-feedback-csrf": context.state.session.csrfToken,
    },
    body: JSON.stringify(requestBody(action, detail, publication)),
  });
}

async function applyPublicationResult(
  context,
  load,
  action,
  detail,
  generation,
  publication,
  result,
) {
  if (!context.isCurrent(detail.itemId, generation)) return;
  if (action === "prepare-publication" && result.status === "prepared") {
    context.update({
      phase: "ready",
      status: result,
      preview: currentPreview(result),
      targetKey: publication.targetKey,
    });
  } else {
    await load(detail, generation, context.state.detailAbort?.signal);
  }
  context.focusResult();
}

async function submitPublication(context, load, action, detail, generation, event) {
  event.preventDefault();
  const publication = context.state.publication;
  if (!canSubmitPublication(context, action, detail, generation, event, publication)) return;
  try {
    context.setBusy(true);
    const result = await publicationRequest(context, action, detail, publication);
    await applyPublicationResult(context, load, action, detail, generation, publication, result);
  } catch (error) {
    handlePublicationError(context, error, detail, generation, publication, true);
  } finally {
    context.setBusy(false);
  }
}

function publicationTargetSelect(context, available, selectedKey) {
  if (available.length === 1) return null;
  const target = element("select", { id: "mq-publication-target" });
  available.forEach((candidate) =>
    target.append(
      element("option", { value: candidate.targetKey, textContent: targetLabel(candidate) }),
    ),
  );
  target.value = selectedKey;
  target.addEventListener("change", () => {
    context.state.publication = { ...context.state.publication, targetKey: target.value };
  });
  return target;
}

function prepareForm(context, submit, detail, generation, publication) {
  const available = context.state.session.publicationTargets;
  if (available.length === 0) return context.notice(copy("noTargets"), "warning");
  const selectedKey = publication.targetKey || available[0].targetKey;
  if (publication.targetKey !== selectedKey)
    context.state.publication = { ...publication, targetKey: selectedKey };
  const target = publicationTargetSelect(context, available, selectedKey);
  const selection =
    target === null
      ? element("p", { className: "mq-muted", textContent: targetLabel(available[0]) })
      : element("label", { htmlFor: target.id, textContent: copy("target") }, [target]);
  const form = element("form", { className: "mq-action" }, [
    element("h3", { textContent: copy("prepare") }),
    element("p", { textContent: copy("prepareHelp") }),
    selection,
    context.button(copy("prepare"), undefined, "mq-button--primary", "submit"),
  ]);
  form.addEventListener(
    "submit",
    (event) => void submit("prepare-publication", detail, generation, event),
  );
  return form;
}

function preparedActions(context, submit, detail, generation) {
  const approval = element("form", { className: "mq-action" }, [
    element("h3", { textContent: copy("approve") }),
    element("p", { textContent: copy("approveHelp") }),
    context.button(copy("approve"), undefined, "mq-button--primary", "submit"),
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
    context.button(copy("cancel"), undefined, "mq-button--danger", "submit"),
  ]);
  cancel.addEventListener(
    "submit",
    (event) => void submit("cancel-publication-route-private", detail, generation, event),
  );
  return element("div", { className: "mq-action-grid" }, [approval, cancel]);
}

function publicationStatusContent(context, submit, detail, generation, publication) {
  const content = [
    element("p", {
      id: "mq-publication-result",
      tabIndex: "-1",
      textContent: statusMessage(publication.status),
    }),
  ];
  if (publication.status.failureCode)
    content.push(
      context.notice(copy(FAILURE_COPY[publication.status.failureCode] || "manual"), "warning"),
    );
  if (publication.preview) content.push(previewNode(publication.preview));
  if (publication.status.status === "prepared" && publication.preview)
    content.push(preparedActions(context, submit, detail, generation));
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
  return content;
}

function publicationBody(context, submit, detail, generation, publication) {
  if (publication === null || publication?.phase === "loading")
    return [context.notice(copy("loading"))];
  if (publication.phase === "error") {
    const error = context.notice(copy(publication.error), "error");
    error.id = "mq-publication-result";
    error.tabIndex = -1;
    return [error];
  }
  if (publication.status.status === "none")
    return [prepareForm(context, submit, detail, generation, publication)];
  return publicationStatusContent(context, submit, detail, generation, publication);
}

function renderPublication(context, load, submit, detail, generation) {
  if (!publicationEnabled(context.state.session)) return null;
  const content = [element("h3", { id: "mq-publication-heading", textContent: copy("title") })];
  content.push(...publicationBody(context, submit, detail, generation, context.state.publication));
  const refresh = context.button(copy("refresh"), () => void load(detail, generation));
  refresh.id = "mq-publication-refresh";
  content.push(refresh);
  return element(
    "section",
    { className: "mq-publication mq-stack", "aria-labelledby": "mq-publication-heading" },
    content,
  );
}

export function createPublicationUi(options) {
  const context = createPublicationContext(options);
  const load = (detail, generation, signal) => loadPublication(context, detail, generation, signal);
  const submit = (action, detail, generation, event) =>
    submitPublication(context, load, action, detail, generation, event);
  return {
    load,
    render: (detail, generation) => renderPublication(context, load, submit, detail, generation),
  };
}
