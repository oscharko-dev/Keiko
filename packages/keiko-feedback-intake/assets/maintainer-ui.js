import { copy, german, reasonLabel, statusLabel } from "./maintainer-ui-copy.js";
import { createUiHelpers, element, metadata, renderError, text } from "./maintainer-ui-dom.js";
import * as detailUi from "./maintainer-ui-detail.js";
import { createPublicationUi, publicationEnabled } from "./maintainer-ui-publication.js";

const root = document.getElementById("mq-app");
document.documentElement.lang = german ? "de" : "en";
document.title = `Keiko ${copy.title}`;
document.getElementById("mq-title").textContent = copy.title;
document.getElementById("mq-skip").textContent = copy.skip;
const state = {
  session: null,
  cursor: null,
  items: [],
  filter: "",
  selected: null,
  detail: null,
  lastFocus: null,
  auditTrigger: null,
  publication: null,
  detailGeneration: 0,
  detailAbort: null,
  busy: false,
};
const endpoint = "/v1/maintainer/";
const { button, notice, replace, request, setBusy } = createUiHelpers(root, state, endpoint);
const publication = createPublicationUi({
  state,
  request,
  button,
  notice,
  setBusy,
  rerender: () => renderDetail(),
  isCurrent: (itemId, generation) =>
    state.selected === itemId && state.detailGeneration === generation,
  focusResult: () => document.getElementById("mq-publication-result")?.focus(),
  onSessionExpired: () => detailUi.expireMaintainerSession(state, errorView),
});
function signIn() {
  window.location.assign(`${endpoint}auth/login`);
}
function signInView(message) {
  replace([
    notice(message || copy.session, "warning"),
    button(copy.signIn, signIn, "mq-button--primary"),
  ]);
}
const errorView = (error) => renderError(error, copy, button, notice, replace, signIn, loadQueue);

function permitted(permission) {
  return state.session.permissions.includes(permission);
}
function filterSelect() {
  const label = element("label", { className: "mq-label", textContent: copy.filter });
  const select = element("select", { name: "state" });
  [
    ["", copy.all],
    ["pending", "pending"],
    ["duplicate", "duplicate"],
    ["rejected", "rejected"],
    ["archived", "archived"],
    ["private-security", "private security"],
    ["expired", "expired"],
  ].forEach(([value, labelText]) =>
    select.append(element("option", { value, textContent: labelText })),
  );
  select.value = state.filter;
  select.addEventListener("change", () => {
    state.filter = select.value;
    state.cursor = null;
    state.items = [];
    void loadQueue();
  });
  label.htmlFor = "mq-state-filter";
  select.id = "mq-state-filter";
  return element("div", { className: "mq-filter" }, [label, select]);
}
function itemRow(item) {
  const inspect = element("button", {
    type: "button",
    className: "mq-row-button",
    textContent: item.itemId,
  });
  inspect.addEventListener("click", () => {
    state.lastFocus = inspect;
    void openDetail(item.itemId);
  });
  const cells = [
    inspect,
    element("span", { className: "mq-badge", textContent: statusLabel(item.state) }),
    text(String(item.groupCount)),
    text(item.category),
    text(item.featureArea),
    text(item.impact),
  ].map((content) => element("td", {}, [content]));
  return element("tr", { "aria-current": String(state.selected === item.itemId) }, cells);
}
function queueView(message) {
  const heading = element("h2", { textContent: copy.queue, tabIndex: "-1" });
  const audit = permitted("feedback.audit") ? button(copy.audit, () => void loadAudit()) : null;
  state.auditTrigger = audit;
  const toolbar = element("div", { className: "mq-toolbar" }, [
    filterSelect(),
    element("div", {}, [audit ?? text(""), button(copy.signOut, () => void logout())]),
  ]);
  const table = element("table", { className: "mq-table" }, [
    element("caption", {
      className: "mq-label",
      textContent: `${state.items.length} ${copy.loaded}`,
    }),
    element("thead", {}, [
      element(
        "tr",
        {},
        [copy.item, copy.status, copy.group, copy.category, copy.feature, copy.impact].map(
          (label) => element("th", { scope: "col", textContent: label }),
        ),
      ),
    ]),
    element("tbody", {}, state.items.map(itemRow)),
  ]);
  const children = [heading, toolbar];
  if (message) children.push(notice(message));
  if (state.items.length === 0) children.push(notice(copy.empty));
  else children.push(element("div", { className: "mq-table-wrap" }, [table]));
  if (state.cursor)
    children.push(
      element("div", { className: "mq-footer" }, [button(copy.load, () => void loadQueue(true))]),
    );
  replace([
    element(
      "section",
      { className: "mq-panel mq-stack", "aria-labelledby": "mq-queue-heading" },
      children,
    ),
  ]);
  heading.id = "mq-queue-heading";
}
async function loadQueue(append = false, message) {
  try {
    setBusy(true);
    const query = new URLSearchParams({ limit: "25" });
    if (state.filter) query.set("state", state.filter);
    if (append && state.cursor) query.set("cursor", state.cursor);
    const page = await request(`reviews?${query.toString()}`);
    state.items = append ? state.items.concat(page.items) : page.items;
    state.cursor = page.nextCursor || null;
    state.selected = null;
    queueView(message);
  } catch (error) {
    errorView(error);
  } finally {
    setBusy(false);
  }
}
function field(labelText, control) {
  const label = element("label", { htmlFor: control.id, textContent: labelText });
  label.append(control);
  return label;
}
function actionCard(title, description, action, controls = []) {
  const form = element("form", { className: "mq-action" });
  const showValidation = () => {
    if (form.querySelector(".mq-validation")) return;
    const validation = notice(copy.validation, "error");
    validation.classList.add("mq-validation");
    form.append(validation);
  };
  const submit = button(
    title,
    undefined,
    action === "route-private-security" ? "mq-button--danger" : "",
    "submit",
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    form.querySelector(".mq-validation")?.remove();
    if (form.reportValidity()) void submitAction(action, controls);
    else showValidation();
  });
  form.addEventListener("invalid", showValidation, true);
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.append(
    element("h3", { textContent: title }),
    element("p", { textContent: description }),
    ...controls,
    submit,
  );
  return form;
}
function actionControls(detail) {
  const cards = [];
  if (detail.state !== "pending") return legalHoldCards(cards);
  const reject = element("select", { name: "reason", id: "mq-reason" });
  ["insufficient-information", "not-actionable", "out-of-scope", "policy-violation"].forEach(
    (reason) =>
      reject.append(element("option", { value: reason, textContent: reasonLabel(reason) })),
  );
  const duplicate = element("input", {
    name: "targetItemId",
    type: "text",
    id: "mq-duplicate-target",
    placeholder: "00000000-0000-4000-8000-000000000000",
    required: true,
  });
  cards.push(
    actionCard(copy.archive, copy.archiveHelp, "archive"),
    actionCard(copy.reject, copy.rejectHelp, "reject", [field(copy.reason, reject)]),
    actionCard(copy.duplicate, copy.duplicateHelp, "mark-duplicate", [
      field(copy.duplicateTarget, duplicate),
    ]),
  );
  if (permitted("feedback.security"))
    cards.push(actionCard(copy.private, copy.privateHelp, "route-private-security"));
  return legalHoldCards(cards);
}
function renderDetail(focus = false) {
  detailUi.renderMaintainerDetail(
    {
      state,
      copy,
      button,
      metadata,
      statusLabel,
      replace,
      actionControls,
      publication,
      onBack: () => {
        state.detailAbort?.abort();
        state.detailAbort = null;
        state.detailGeneration += 1;
        state.selected = null;
        state.detail = null;
        state.publication = null;
        queueView();
        state.lastFocus?.focus();
      },
    },
    focus,
  );
}
function legalHoldCards(cards) {
  if (!permitted("feedback.legal-hold")) return cards;
  if (state.detail.legalHold.status === "active")
    cards.push(actionCard(copy.releaseHold, copy.activeHold, "release-legal-hold"));
  else if (state.detail.legalHold.status === "expired")
    cards.push(actionCard(copy.expireHold, copy.expireHelp, "expire-legal-hold"));
  else cards.push(holdCard());
  return cards;
}
function holdCard() {
  const policy = element("select", { name: "policyKey", id: "mq-policy" });
  (state.session.legalHoldPolicyKeys || []).forEach((key) =>
    policy.append(element("option", { value: key, textContent: key })),
  );
  const reviewAt = element("input", {
    name: "reviewAt",
    type: "datetime-local",
    id: "mq-review-at",
    required: true,
  });
  const expiresAt = element("input", {
    name: "expiresAt",
    type: "datetime-local",
    id: "mq-expires-at",
    required: true,
  });
  if ((state.session.legalHoldPolicyKeys || []).length === 0)
    return element("section", { className: "mq-action" }, [
      element("h3", { textContent: copy.hold }),
      notice(copy.noPolicies, "warning"),
    ]);
  return actionCard(copy.hold, copy.holdHelp, "place-legal-hold", [
    element("fieldset", {}, [
      element("legend", { textContent: copy.hold }),
      field(copy.policy, policy),
      field(copy.reviewAt, reviewAt),
      field(copy.expiresAt, expiresAt),
    ]),
  ]);
}
function openDetail(itemId) {
  return detailUi.openMaintainerDetail(itemId, {
    state,
    request,
    setBusy,
    errorView,
    publicationEnabled,
    publication,
    renderDetail,
  });
}
function actionData(action, controls) {
  const data = {
    action,
    expectedVersion: state.detail.version,
    expectedPayloadDigest: state.detail.payloadDigest,
    idempotencyKey: crypto.randomUUID().replaceAll("-", ""),
  };
  controls
    .flatMap((control) => [...control.querySelectorAll("input, select")])
    .forEach((control) => {
      if (control.name) data[control.name] = control.value;
    });
  if (data.reviewAt) data.reviewAt = new Date(data.reviewAt).toISOString();
  if (data.expiresAt) data.expiresAt = new Date(data.expiresAt).toISOString();
  return data;
}
async function submitAction(action, controls) {
  const item = state.items.find((candidate) => candidate.itemId === state.selected);
  if (!item) return;
  try {
    setBusy(true);
    await request(`reviews/${item.itemId}/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "keiko-feedback-csrf": state.session.csrfToken,
      },
      body: JSON.stringify(actionData(action, controls)),
    });
    await loadQueue(false, copy.applied);
    document.getElementById("mq-queue-heading")?.focus();
  } catch (error) {
    errorView(error);
  } finally {
    setBusy(false);
  }
}
async function loadAudit() {
  try {
    setBusy(true);
    const result = await request("audit?limit=25");
    const items = result.events.map((event) =>
      element("li", {
        textContent: `${event.action}: ${statusLabel(event.priorState)} → ${statusLabel(event.resultState)} (${event.eventAt})`,
      }),
    );
    const heading = element("h2", { textContent: copy.auditTitle, tabIndex: "-1" });
    replace([
      element("section", { className: "mq-panel mq-stack" }, [
        heading,
        button(copy.close, () => {
          queueView();
          state.auditTrigger?.focus();
        }),
        element("ol", { className: "mq-audit" }, items),
      ]),
    ]);
    heading.focus();
  } catch (error) {
    errorView(error);
  } finally {
    setBusy(false);
  }
}
async function logout() {
  try {
    state.detailAbort?.abort();
    state.detailAbort = null;
    state.detailGeneration += 1;
    state.selected = null;
    state.detail = null;
    state.publication = null;
    await request("auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: window.location.origin,
        "keiko-feedback-csrf": state.session.csrfToken,
      },
      body: "{}",
    });
    signInView();
  } catch (error) {
    errorView(error);
  }
}
async function bootstrap() {
  try {
    setBusy(true);
    state.session = await request("auth/session");
    if (!permitted("feedback.review")) throw new Error("forbidden");
    await loadQueue();
  } catch (error) {
    if (error instanceof Error && error.message === "session") signInView();
    else errorView(error);
  } finally {
    setBusy(false);
  }
}
replace([notice(copy.loading)]);
window.addEventListener("beforeunload", () => state.detailAbort?.abort(), { once: true });
void bootstrap();
