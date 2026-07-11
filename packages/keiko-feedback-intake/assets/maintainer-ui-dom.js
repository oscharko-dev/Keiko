export function text(value) {
  return document.createTextNode(value);
}

export function element(name, properties, children = []) {
  const node = document.createElement(name);
  Object.entries(properties || {}).forEach(([key, value]) => {
    if (key === "className") node.className = value;
    else if (key === "textContent") node.textContent = value;
    else if (key.startsWith("aria-")) node.setAttribute(key, value);
    else if (
      [
        "type",
        "id",
        "name",
        "value",
        "href",
        "disabled",
        "tabIndex",
        "scope",
        "htmlFor",
        "required",
        "placeholder",
      ].includes(key)
    )
      node[key] = value;
  });
  children.forEach((child) => node.append(child));
  return node;
}

function createNotice(message, kind = "info") {
  const glyph = kind === "error" ? "!" : kind === "warning" ? "△" : "i";
  return element(
    "section",
    {
      className: `mq-notice${kind === "error" ? " mq-notice--error" : kind === "warning" ? " mq-notice--warning" : ""}`,
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    [
      element("p", {}, [
        element("span", {
          className: "mq-notice-glyph",
          "aria-hidden": "true",
          textContent: glyph,
        }),
        text(message),
      ]),
    ],
  );
}

function requestError(response) {
  if (response.status === 401) return "session";
  if (response.status === 403) return "forbidden";
  if (response.status === 404) return "stale";
  if (response.status === 409) return "conflict";
  if (response.status === 429) return "rateLimited";
  if (response.status === 503) return "unavailable";
  return "failed";
}

function createRequest(endpoint) {
  return async (path, options = {}) => {
    const response = await fetch(`${endpoint}${path}`, { credentials: "same-origin", ...options });
    if (!response.ok) throw new Error(requestError(response));
    return response.status === 204 ? undefined : response.json();
  };
}

function applyBusy(root, state, value) {
  state.busy = value;
  root.setAttribute("aria-busy", String(value));
  root.querySelectorAll("button, input, select").forEach((control) => {
    if (value && !control.disabled) {
      control.dataset.mqBusyDisabled = "true";
      control.disabled = true;
    } else if (!value && control.dataset.mqBusyDisabled === "true") {
      delete control.dataset.mqBusyDisabled;
      control.disabled = false;
    }
  });
}

export function createUiHelpers(root, state, endpoint) {
  function replace(children) {
    root.replaceChildren(...children);
    root.setAttribute("aria-busy", String(state.busy));
  }
  function button(label, onClick, variant = "", type = "button") {
    const node = element("button", {
      type,
      className: `mq-button ${variant}`,
      textContent: label,
      disabled: state.busy,
    });
    if (state.busy) node.dataset.mqBusyDisabled = "true";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }
  return {
    button,
    notice: createNotice,
    replace,
    request: createRequest(endpoint),
    setBusy: (value) => applyBusy(root, state, value),
  };
}

export function metadata(detail, copy, statusLabel) {
  const hold =
    detail.legalHold.status === "active"
      ? copy.activeHold
      : detail.legalHold.status === "expired"
        ? copy.expiredHold
        : copy.noHold;
  const values = [
    [copy.status, statusLabel(detail.state)],
    [copy.group, String(detail.groupCount)],
    [copy.category, detail.category],
    [copy.feature, detail.featureArea],
    [copy.impact, detail.impact],
    [copy.version, String(detail.version)],
    [copy.hold, hold],
  ];
  return element(
    "dl",
    { className: "mq-meta" },
    values.map(([label, value]) =>
      element("div", {}, [
        element("dt", { className: "mq-label", textContent: label }),
        element("dd", { textContent: value }),
      ]),
    ),
  );
}
