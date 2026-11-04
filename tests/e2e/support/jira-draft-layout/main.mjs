/* global window, document, URLSearchParams */
// Browser harness for the Jira draft preview (#4182). It mounts the PRODUCT component with the
// product design tokens and globals.css, so geometry is measured on the real styles. It owns no
// layout rule of its own: a narrow panel is the narrow viewport the spec opens.
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../../../packages/keiko-ui/src/lib/i18n";
import { loadOptionalWidgetMessages } from "../../../../packages/keiko-ui/src/lib/optional-widget-i18n";
import { JiraDraftPreview } from "../../../../packages/keiko-ui/src/app/components/desktop/JiraDraftPreview";
import { jiraDraftTree } from "../../../../packages/keiko-ui/src/app/components/desktop/jiraDraftTree";
import chatTools from "../../../../packages/keiko-ui/src/app/components/desktop/JiraChatTools.module.css";
import "../../../../packages/keiko-ui/src/app/globals.css";

const params = new URLSearchParams(window.location.search);
const locale = params.get("locale") === "de" ? "de" : "en";
window.localStorage.setItem("keiko.locale", locale);

function nested(names, leaf) {
  return names.reduceRight((inner, name) => ({ [name]: inner }), leaf);
}
const SEGMENTS = ["portfolioConfiguration", "approvalWorkflow", "conditions", "reviewerName"];
const LONG_TEXT = "Reviewer notes that are long enough to be collapsed until expanded. ".repeat(5);
const FIELDS = {
  shallow: { customfield_12345: { reviewerName: "Ada Reviewer" } },
  nested: { customfield_12345: nested(SEGMENTS, "Ada Reviewer") },
  // Deeper than the product's value-depth bound, so the subtree is laid out as dotted paths.
  flattened: {
    customfield_12345: nested(["a1", "a2", "a3", "a4", "a5", "a6", "a7", ...SEGMENTS], "Ada"),
  },
  long: { description: LONG_TEXT },
};

const shape = params.get("shape") ?? "shallow";
const tree = jiraDraftTree({
  items: [
    {
      ref: "story",
      projectId: "10000",
      issueTypeId: "10001",
      fields: { summary: "Review the portfolio configuration", ...FIELDS[shape] },
    },
  ],
});
if (tree === undefined) throw new TypeError("The harness draft is not readable");

await loadOptionalWidgetMessages(locale);
const preview = createElement(JiraDraftPreview, {
  tree,
  deselected: new Set(),
  excluded: new Set(),
  editable: true,
  toggle: () => undefined,
});
const card = createElement(
  "div",
  { className: chatTools.cmpCard, "data-harness": "card" },
  preview,
);
createRoot(document.getElementById("root")).render(
  createElement(StrictMode, null, createElement(I18nProvider, null, card)),
);
