import { element } from "./maintainer-ui-dom.js";

export function renderMaintainerDetail(options, focus = false) {
  const {
    state,
    copy,
    button,
    metadata,
    statusLabel,
    replace,
    actionControls,
    publication,
    onBack,
  } = options;
  if (state.detail === null || state.selected === null) return;
  const heading = element("h2", {
    id: "mq-detail-heading",
    textContent: copy.detail,
    tabIndex: "-1",
  });
  const content = [
    heading,
    button(copy.back, onBack),
    metadata(state.detail, copy, statusLabel),
    element("h3", { textContent: copy.payload }),
    element("pre", { className: "mq-payload", textContent: state.detail.canonicalPayload }),
  ];
  const surface = publication.render(state.detail, state.detailGeneration);
  if (surface) content.push(surface);
  const cards = actionControls(state.detail);
  if (cards.length)
    content.push(
      element("section", { className: "mq-action-grid", "aria-label": copy.actions }, cards),
    );
  replace([element("article", { className: "mq-panel mq-stack" }, content)]);
  if (focus) heading.focus();
}

export async function openMaintainerDetail(itemId, options) {
  const { state, request, setBusy, errorView, publicationEnabled, publication, renderDetail } =
    options;
  const generation = state.detailGeneration + 1;
  state.detailGeneration = generation;
  state.detailAbort?.abort();
  const controller = new AbortController();
  state.detailAbort = controller;
  try {
    setBusy(true);
    const detail = await request(`reviews/${itemId}`, { signal: controller.signal });
    if (state.detailGeneration !== generation || controller.signal.aborted) return;
    state.selected = itemId;
    state.detail = detail;
    state.publication = publicationEnabled(state.session) ? { phase: "loading" } : null;
    renderDetail(true);
    setBusy(false);
    if (publicationEnabled(state.session))
      await publication.load(detail, generation, controller.signal);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) errorView(error);
  } finally {
    setBusy(false);
  }
}

export function expireMaintainerSession(state, errorView) {
  state.detailAbort?.abort();
  state.detailAbort = null;
  state.detailGeneration += 1;
  state.session = null;
  state.items = [];
  state.selected = null;
  state.detail = null;
  state.lastFocus = null;
  state.publication = null;
  errorView(new Error("session"));
}
