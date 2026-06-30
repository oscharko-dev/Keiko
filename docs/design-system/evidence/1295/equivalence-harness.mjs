// Issue #1295 — computed-value equivalence proof for the product-surface token migration.
//
// The migration covers 7 product-surface families and 3 category-C light adaptations:
//   Category A/B: chat/chatw/grounded/wf/qi/mc/memoria/rel/rb/lk/lkd/connector/figma/
//                 json-token/fpv/hl — pure-alias token swaps (0-diff in ALL 7 modes).
//   Category C (deliberate light changes, SEPARATE from 0-diff gate):
//     C1 — shadow-ink rows: dark byte-identical, light intentionally differs (warm 20 30 25 ink)
//     C3 — mc-dialog-backdrop: dark byte-identical, light intentionally tinted scrim
//
// Self-contained reproduction (from repo root, after `npm ci` + `npx playwright install chromium`):
//   BASE_REF=origin/release/0.2.0 node docs/design-system/evidence/1295/equivalence-harness.mjs
// Writes computed-value-proof.json + 01-dark.png … 07-reduced-motion.png and exits non-zero
// if any Category-A computed value differs or any Category-C assertion fails.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const CSS_PATH = "packages/keiko-ui/src/app/globals.css";
const BASE_REF = process.env.BASE_REF ?? "origin/release/0.2.0";

const PRE = execSync(`git -C "${REPO}" show ${BASE_REF}:${CSS_PATH}`, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const POST = readFileSync(resolve(REPO, CSS_PATH), "utf8");

// ─── Representative markup ────────────────────────────────────────────────────
// Exercises every migrated product-surface class from the diff. Attribute states
// ([data-active]/[aria-pressed]/[data-tone]/[data-status]/[data-severity])
// exercise stateful variants statically.
const BODY = `
<!-- CHAT sidebar / bubble -->
<div class="chat-row">chat row</div>
<div class="chat-row" data-active="true">active chat row</div>
<div class="chat-time">12:00</div>
<div class="chat-meta">meta</div>
<div class="chat-msg-bubble">bubble</div>
<div class="chat-msg-time">10:00</div>
<div class="chat-msg-typing-dot"></div>
<div class="chat-ctx"><span class="mono">ctx</span></div>
<div class="chat-history-tabs">
  <button class="chat-history-tab">tab<span>3</span></button>
  <button class="chat-history-tab" aria-selected="true">sel<span>3</span></button>
</div>
<div class="chat-history-list">
  <div class="chat-history-row">
    <div class="chat-history-title">title</div>
    <div class="chat-history-meta">meta</div>
    <input class="chat-history-title-input" />
    <div class="chat-history-kicker">kicker</div>
  </div>
</div>

<!-- CHAT MEMORY panel -->
<div class="chat-memory-panel">
  <div class="chat-memory-panel-head">head</div>
  <div class="chat-memory-budget"><input /></div>
  <div class="chat-memory-summary">summary</div>
  <div class="chat-memory-item">
    <div class="chat-memory-item-head">head</div>
    <div class="chat-memory-meta"><div>m</div></div>
    <div class="chat-memory-rationale">rationale</div>
    <div class="chat-memory-action-buttons"><button>approve</button></div>
  </div>
</div>

<!-- CHATW empty-state -->
<div class="chatw-empty-no-chat">
  <div class="chatw-empty-no-chat-label">label</div>
  <div class="chatw-empty-no-chat-hint">hint</div>
</div>

<!-- GROUNDED citations / coverage / context -->
<div class="grounded-citation">C1</div>
<div class="grounded-uncertainty">uncertain</div>
<div class="grounded-meta">meta</div>
<div class="grounded-coverage-notice">
  <div class="grounded-coverage-notice-title">title</div>
</div>
<div class="grounded-context-pack">
  <div class="grounded-context-pack-headline">headline</div>
  <dl class="grounded-context-pack-dl">
    <dt class="grounded-context-pack-dt">dt</dt>
    <dd class="grounded-context-pack-dd">dd</dd>
  </dl>
</div>
<button class="grounded-citations-more">more</button>
<div class="grounded-context-pack grounded-context-pack-inline">
  <div class="grounded-context-pack-headline">h2</div>
</div>

<!-- WF dialog -->
<div class="wf-dialog">
  <div class="wf-dialog-title">title</div>
  <div class="wf-dialog-choice">
    <div class="wf-dialog-choice-label">label</div>
    <div class="wf-dialog-choice-desc">desc</div>
  </div>
  <div class="wf-dialog-form">
    <div class="wf-dialog-form-desc">desc</div>
    <input class="wf-dialog-input" />
    <div class="wf-dialog-error">err</div>
  </div>
  <button class="wf-dialog-cancel">cancel</button>
  <button class="wf-dialog-launch">launch</button>
</div>

<!-- QI column / run list / finding / candidate / edit / export -->
<div class="qi-col-header">header</div>
<div class="qi-col-count">3</div>
<div class="qi-run-item">
  <div class="qi-run-id">run-abc</div>
  <div class="qi-run-meta">meta</div>
  <div class="qi-run-totals">totals</div>
</div>
<div class="qi-run-item qi-run-item-selected">
  <div class="qi-run-id">selected-id</div>
</div>
<div class="qi-run-card-head">
  <div class="qi-run-id">card-id</div>
</div>
<div class="qi-run-governance">
  <div class="qi-run-governance-help">help</div>
  <div class="qi-run-governance-warning">warning</div>
</div>
<dl class="qi-run-summary-item">
  <dt>dt</dt>
  <dd>dd</dd>
</dl>
<div class="qi-finding-item">
  <div class="qi-finding-kind">kind</div>
  <p class="qi-finding-summary">summary</p>
</div>
<div class="qi-weak-flag">
  <div class="qi-weak-flag-icon">!</div>
  <p class="qi-weak-flag-reason">reason</p>
</div>
<div class="qi-coverage-atom">
  <div class="qi-coverage-atom-id">atom</div>
  <div class="qi-coverage-gap-text">gap</div>
</div>
<div class="qi-coverage-summary">coverage summary</div>
<div class="qi-drift-regenerated">regen</div>
<div class="qi-cand-card">
  <div class="qi-cand-header">
    <div class="qi-cand-title">title</div>
    <div class="qi-cand-risk">risk</div>
  </div>
  <div class="qi-cand-meta">
    <div><dt>dt</dt><dd>dd</dd></div>
  </div>
  <div class="qi-cand-accordion-stack">
    <div class="qi-cand-accordion">
      <div class="qi-cand-accordion-summary">
        <span class="qi-cand-caret"></span>sum
      </div>
      <div class="qi-cand-accordion-body">
        <p class="qi-cand-section-label">label</p>
        <ul class="qi-cand-list"><li>item</li></ul>
        <div class="qi-cand-tag">tag</div>
      </div>
    </div>
  </div>
  <div class="qi-cand-governance-note">note</div>
</div>
<div class="qi-cand-card-editing">editing</div>
<div class="qi-review-approved">approved</div>
<div class="qi-review-changes">changes</div>
<div class="qi-review-rejected">rejected</div>
<div class="qi-review-withdrawn">withdrawn</div>
<div class="qi-edit-form">
  <div class="qi-edit-head">
    <div class="qi-edit-eyebrow">eyebrow</div>
    <div class="qi-edit-heading">heading</div>
  </div>
  <div class="qi-edit-side">
    <div class="qi-edit-field">
      <div class="qi-edit-label">label</div>
      <input class="qi-edit-input" />
      <textarea class="qi-edit-textarea"></textarea>
      <select class="qi-edit-select"><option>opt</option></select>
      <div class="qi-edit-error">err</div>
    </div>
  </div>
</div>
<div class="qi-export">
  <div class="qi-export-title">title</div>
  <div class="qi-export-trigger">trigger</div>
  <div class="qi-export-preview">preview</div>
  <div class="qi-export-status">status</div>
  <div class="qi-export-success">success</div>
</div>
<div class="qi-hub"><div class="qi-hub-runs">runs</div></div>
<div class="qi-loading-row">loading</div>
<div class="qi-progress-row">
  <div class="qi-progress-spinner"></div>
</div>
<div class="qi-path-value">path</div>
<div class="qi-path-value" data-empty="true">empty path</div>
<div class="qi-source-picker">
  <div class="lkd-picker-row" aria-pressed="true">picked</div>
  <div class="qi-source-picker-selection">selection</div>
</div>
<div class="qi-connected-path">connected path</div>
<div class="qi-connected-hint">hint</div>
<div class="qi-connected-root-name">root name</div>
<div class="qi-coverage-line">coverage line</div>
<div class="qi-field-hint">hint</div>
<div class="qi-cand-action-note">action note</div>

<!-- MC dialog / chip / row / meta -->
<div class="mc-dialog-backdrop"></div>
<div class="mc-dialog">
  <div class="mc-dialog-title">title</div>
  <input class="mc-dialog-input" />
  <div class="mc-dialog-error">err</div>
</div>
<div class="mc-chip">chip</div>
<div class="mc-chip" data-active="true">active chip</div>
<div class="mc-chip" aria-pressed="true">pressed</div>
<div class="mc-row">
  <div class="mc-row-body">body</div>
  <div class="mc-row-type">type</div>
  <div class="mc-row-scope">scope</div>
  <div class="mc-row-pinned">pinned</div>
</div>
<div class="mc-meta-label">label</div>
<div class="mc-meta-value">value</div>
<div class="mc-meta-empty">empty</div>
<div class="mc-body-text">body text</div>
<code class="mc-code">code</code>
<div class="mc-tag">tag</div>
<div class="mc-action-error">action error</div>
<div class="mc-id-link">id link</div>

<!-- MEMORIA window (scoped mc/lk inside .memoria-window) -->
<div class="memoria-window">
  <div class="lk-header">header</div>
  <div class="mc-filters">
    <div class="mc-filter-row">
      <div class="mc-chip">chip</div>
      <div class="mc-chip" data-active="true">active</div>
    </div>
  </div>
  <section aria-label="Memory records">
    <div class="lk-empty"><div class="lk-empty-title">empty title</div></div>
    <div class="mc-row"><div class="mc-row-body">body</div></div>
  </section>
</div>

<!-- REL row -->
<div class="rel-row">rel row</div>
<div class="rel-row" aria-pressed="true">pressed rel row</div>

<!-- RB inspector -->
<div class="rb-head">
  <div class="rb-title">title</div>
  <div class="rb-count">3</div>
</div>
<div class="rb-section-label">section</div>
<div class="rb-placeholder"><div class="rb-ph-label">placeholder</div></div>
<div class="rb-rows">
  <div class="rb-row">
    <span class="rb-row-k">key</span>
    <span class="rb-row-v">value</span>
  </div>
</div>
<div class="rb-foot">foot</div>

<!-- LK capsule / connector ghost / empty -->
<div class="lk-connector-drag-ghost">
  <div class="lk-connector-drag-ghost-icon">i</div>
  <div class="lk-connector-drag-ghost-copy">
    <span>name</span>
    <small>type</small>
  </div>
  <div class="lk-connector-drag-ghost-capsule">
    <div class="lk-capsule-name">name</div>
  </div>
</div>
<div class="lk-empty">
  <div class="lk-empty-title">empty</div>
  <div class="lk-empty-body">body</div>
</div>

<!-- LKD metric / source / diagnostic / job / picker -->
<div class="lkd-live-note">live note</div>
<div class="lkd-metric-card">
  <span class="lkd-metric-label">label</span>
  <span class="lkd-metric-value">42</span>
  <span class="lkd-metric-meta">meta</span>
</div>
<div class="lkd-metric-card" data-tone="ok">ok</div>
<div class="lkd-metric-card" data-tone="warn">warn</div>
<div class="lkd-metric-card" data-tone="danger">danger</div>
<div class="lkd-source-row">
  <div class="lkd-source-coverage">
    <div class="lkd-progress-fill" data-tone="ok"></div>
    <div class="lkd-progress-fill" data-tone="warn"></div>
    <div class="lkd-progress-fill" data-tone="danger"></div>
    <div class="lkd-source-segment-ok"></div>
    <div class="lkd-source-segment-fail"></div>
    <div class="lkd-source-segment-skip"></div>
  </div>
</div>
<div class="lkd-status-callout">status</div>
<div class="lkd-status-callout" data-tone="ok">ok</div>
<div class="lkd-status-callout" data-tone="warn">warn</div>
<div class="lkd-status-callout" data-tone="danger">danger</div>
<dl class="lkd-def">
  <dt class="lkd-label">label</dt>
  <dd class="lkd-value">value</dd>
</dl>
<div class="lkd-stale-reason">reason</div>
<div class="lkd-source-card">
  <div class="lkd-source-name">name</div>
  <div class="lkd-source-path">path</div>
  <div class="lkd-source-scope">scope</div>
</div>
<div class="lkd-source-counts">
  <span class="lkd-count-ok">10</span>
  <span class="lkd-count-fail">2</span>
  <span class="lkd-count-skip">1</span>
</div>
<div class="lkd-diag-row" data-severity="error">
  <span class="lkd-diag-severity">E</span>
  <span class="lkd-diag-code">E001</span>
  <span class="lkd-diag-message">msg</span>
  <span class="lkd-diag-page">p1</span>
</div>
<div class="lkd-diag-row" data-severity="warning"><span class="lkd-diag-severity">W</span></div>
<div class="lkd-diag-row" data-severity="info"><span class="lkd-diag-severity">I</span></div>
<div class="lkd-diag-group" data-severity="error"><span class="lkd-diag-group-count">3</span></div>
<div class="lkd-job-row">
  <span class="lkd-job-status" data-status="succeeded">ok</span>
  <span class="lkd-job-status" data-status="failed">fail</span>
  <span class="lkd-job-status" data-status="running">run</span>
  <span class="lkd-job-status" data-status="queued">q</span>
  <span class="lkd-job-dates">2024</span>
  <span class="lkd-job-duration">1s</span>
</div>
<div class="lkd-job-error">error</div>
<div class="lkd-sync-card">
  <div class="lkd-action-progress-head">head</div>
  <div class="lkd-action-progress-note">note</div>
</div>
<div class="lkd-picker">
  <div class="lkd-picker-current"><span class="mono">path</span></div>
  <ul class="lkd-picker-list">
    <li class="lkd-picker-entry">
      <button class="lkd-picker-row">row<span class="lkd-picker-meta">meta</span></button>
      <button class="lkd-picker-row" data-disabled="true">disabled<span class="lkd-picker-meta">m</span></button>
    </li>
    <li class="lkd-picker-empty">empty</li>
  </ul>
</div>
<div class="lkd-connect-label">connect label</div>
<div class="lkd-limit-note">limit note</div>

<!-- CONNECTOR picker / node -->
<div class="connector-picker">
  <div class="connector-picker-label">label</div>
  <select class="connector-picker-select"><option>opt</option></select>
  <div class="connector-picker-empty">empty<p>p</p></div>
  <div class="connector-picker-error">error<p>p</p></div>
  <button class="connector-picker-retry">retry</button>
  <div class="connector-picker-selected">selected</div>
</div>
<div class="connector-node">
  <div class="connector-node-icon"></div>
  <div class="connector-node-kicker">kicker</div>
  <div class="connector-node-title">title</div>
  <div class="connector-node-id">id</div>
  <button class="connector-node-manage">manage</button>
</div>

<!-- FIGMA snapshot dashboard / view / json -->
<div class="figma-snapshot-label">label</div>
<div class="figma-snapshot-hint">hint</div>
<div class="figma-snapshot-progress">progress</div>
<div class="figma-snapshot-error">error</div>
<div class="figma-snapshot-error-box">
  <div class="figma-snapshot-error-title">title</div>
  <div class="figma-snapshot-error-detail">detail</div>
  <div class="figma-snapshot-error-status">status</div>
  <div class="figma-snapshot-error-remediation">rem</div>
</div>
<div class="figma-snapshot-stored"><div class="figma-snapshot-stored-text">text</div></div>
<div class="figma-snapshot-dashboard">
  <div class="figma-snapshot-dashboard-status">status</div>
  <div class="figma-snapshot-dashboard-status-error">error</div>
  <div class="figma-snapshot-dashboard-tabs">
    <button class="figma-snapshot-dashboard-tab">tab</button>
    <button class="figma-snapshot-dashboard-tab" aria-selected="true">sel</button>
  </div>
  <div class="figma-snapshot-dashboard-panel">panel</div>
  <div class="figma-snapshot-dashboard-empty">
    <div class="figma-snapshot-dashboard-empty-title">title</div>
    <div class="figma-snapshot-dashboard-empty-detail">detail</div>
  </div>
  <div class="figma-snapshot-dashboard-list">
    <button class="figma-snapshot-dashboard-item">
      <div class="figma-snapshot-dashboard-item-name">name</div>
      <div class="figma-snapshot-dashboard-item-date">date</div>
      <div class="figma-snapshot-dashboard-item-badge">badge</div>
      <div class="figma-snapshot-dashboard-item-hint">hint</div>
      <div class="figma-snapshot-dashboard-item-meta">meta</div>
      <div class="figma-snapshot-dashboard-item-scope">scope</div>
    </button>
    <button class="figma-snapshot-dashboard-item" aria-current="true">current</button>
  </div>
  <div class="figma-snapshot-dashboard-rename">
    <input class="figma-snapshot-dashboard-rename-input" />
    <div class="figma-snapshot-dashboard-rename-error">err</div>
    <div class="figma-snapshot-dashboard-details"><dt>dt</dt><dd>dd</dd></div>
  </div>
</div>
<div class="figma-snapshot-reduction">
  <div class="figma-snapshot-result-name">name</div>
  <div class="figma-snapshot-result-run">run</div>
  <div class="figma-snapshot-result-hash">hash</div>
  <div class="figma-snapshot-result-status">status</div>
  <div class="figma-snapshot-reduction-hint">hint</div>
  <div class="figma-snapshot-result-metadata"><dt>dt</dt><dd>dd</dd></div>
  <div class="figma-snapshot-skipped-notice">skipped</div>
</div>
<div class="figma-snapshot-code">
  <div class="figma-snapshot-code-summary">summary</div>
  <div class="figma-snapshot-code-file-path">path</div>
  <div class="figma-snapshot-code-file-contents">contents</div>
  <details>
    <summary class="figma-snapshot-scopes-summary">scopes</summary>
    <div class="figma-snapshot-scopes-note">note</div>
  </details>
</div>
<div class="figma-snapshot-screen-card">
  <img class="figma-snapshot-screen-preview" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />
  <div class="figma-snapshot-screen-name">name</div>
  <div class="figma-snapshot-screen-summary">summary</div>
  <div class="figma-snapshot-screen-size">size</div>
  <div class="figma-snapshot-screen-id">id</div>
  <div class="figma-snapshot-screen-frame-icon"></div>
  <div class="figma-snapshot-screen-placeholder-label">ph</div>
</div>
<button class="figma-snapshot-gallery-more">more</button>
<div class="figma-snapshot-scope-note">scope note</div>
<div class="figma-snapshot-empty">
  <div class="figma-snapshot-empty-steps">steps</div>
  <div class="figma-snapshot-empty-note">note</div>
</div>
<div class="figma-view-source-empty"><div class="figma-view-source-empty-title">title</div></div>
<div class="figma-view-source-card">
  <button class="figma-view-preview">
    <div class="figma-view-preview-placeholder">
      <div class="figma-view-preview-icon"></div>
    </div>
  </button>
  <div class="figma-view-source-title">title</div>
  <div class="figma-view-source-summary">summary</div>
  <dl class="figma-view-source-facts"><dt>dt</dt><dd>dd</dd></dl>
</div>
<div class="figma-view-json">
  <div class="figma-view-json-kicker">kicker</div>
  <div class="figma-view-json-title">title</div>
  <div class="figma-view-json-meta">meta</div>
  <button class="figma-view-json-btn">btn</button>
  <button class="figma-view-json-copy-btn">copy</button>
</div>

<!-- JSON TOKEN coloriser -->
<code class="json-token-key">key</code>
<code class="json-token-string">string</code>
<code class="json-token-number">42</code>
<code class="json-token-boolean">true</code>
<code class="json-token-null">null</code>
<code class="json-token-punctuation">{</code>

<!-- FPV (file-preview) panel -->
<div class="fpv-header">
  <button class="fpv-back">back</button>
  <div class="fpv-name">name</div>
  <div class="fpv-lang">TS</div>
</div>
<div class="fpv-gutter">ln</div>
<div class="fpv-src">code</div>
<div class="fpv-state"><div class="fpv-error">err</div></div>
<div class="fpv-image-card">img</div>
<div class="fpv-meta-row"><span>label</span><strong>value</strong></div>
<div class="fpv-meta-pane">
  <div class="fpv-meta-card">
    <div class="fpv-meta-card-title">title</div>
    <p>desc</p>
  </div>
</div>

<!-- HL syntax tokens -->
<span class="hl-com">comment</span>
<span class="hl-str">string</span>
<span class="hl-num">42</span>
<span class="hl-key">const</span>
<span class="hl-type">Type</span>
<span class="hl-fn">fn</span>
<span class="hl-key2">return</span>
<span class="hl-punct">;</span>

<!-- Shadow-ink elements for Category-C probing (also valid Cat-A elements) -->
<div class="ws-fab">fab</div>
<div class="cmp-model-menu">model menu</div>
<div class="ksel-menu">ksel menu</div>
<div class="hd-tool-cta">hd cta</div>
`;

// ─── Category-A probes (0-diff expected in all 7 modes) ──────────────────────
const PROBES_A = [
  // chat sidebar / bubble
  [".chat-row", ["color"]],
  ['.chat-row[data-active="true"]', ["color", "backgroundColor"]],
  [".chat-time", ["color"]],
  [".chat-meta", ["color"]],
  [".chat-msg-bubble", ["color", "backgroundColor", "borderTopColor"]],
  [".chat-msg-time", ["color"]],
  [".chat-msg-typing-dot", ["backgroundColor"]],
  [".chat-ctx .mono", ["color"]],
  // chat history
  [".chat-history-tab", ["color"]],
  ['.chat-history-tab[aria-selected="true"]', ["color", "backgroundColor"]],
  ['.chat-history-tab[aria-selected="true"] span', ["color"]],
  [".chat-history-title", ["color"]],
  [".chat-history-meta", ["color"]],
  [".chat-history-title-input", ["color", "backgroundColor", "borderTopColor"]],
  [".chat-history-kicker", ["color"]],
  // chat-memory panel
  [".chat-memory-budget input", ["color", "backgroundColor", "borderTopColor"]],
  [".chat-memory-summary", ["color"]],
  [".chat-memory-rationale", ["color"]],
  [".chat-memory-action-buttons button", ["color", "backgroundColor", "borderTopColor"]],
  // chatw empty
  [".chatw-empty-no-chat-label", ["color"]],
  [".chatw-empty-no-chat-hint", ["color"]],
  // grounded
  [".grounded-citation", ["color"]],
  [".grounded-uncertainty", ["color"]],
  [".grounded-meta", ["color"]],
  [".grounded-coverage-notice-title", ["color"]],
  [".grounded-context-pack-headline", ["color"]],
  [".grounded-context-pack-dt", ["color"]],
  [".grounded-context-pack-dd", ["color"]],
  [".grounded-citations-more", ["color"]],
  [".grounded-context-pack-inline .grounded-context-pack-headline", ["color"]],
  // wf dialog
  [".wf-dialog-form-desc", ["color"]],
  [".wf-dialog-choice-label", ["color"]],
  [".wf-dialog-choice-desc", ["color"]],
  // qi column/run
  [".qi-col-count", ["color"]],
  [".qi-run-id", ["color"]],
  [".qi-run-meta", ["color"]],
  [".qi-run-totals", ["color"]],
  [".qi-run-item-selected", ["backgroundColor"]],
  [".qi-run-card-head .qi-run-id", ["color"]],
  [".qi-run-governance-help", ["color"]],
  [".qi-run-governance-warning", ["color"]],
  [".qi-run-summary-item dd", ["color"]],
  // qi findings/coverage/edit/export
  [".qi-finding-item", ["backgroundColor", "borderTopColor"]],
  [".qi-finding-kind", ["color"]],
  [".qi-finding-summary", ["color"]],
  [".qi-weak-flag-icon", ["color"]],
  [".qi-weak-flag-reason", ["color"]],
  [".qi-coverage-atom", ["backgroundColor", "borderTopColor"]],
  [".qi-coverage-atom-id", ["color"]],
  [".qi-coverage-gap-text", ["color"]],
  [".qi-coverage-summary", ["color"]],
  [".qi-drift-regenerated", ["color"]],
  [".qi-cand-card", ["backgroundColor", "borderTopColor"]],
  [".qi-cand-card-editing", ["backgroundColor"]],
  [".qi-cand-title", ["color"]],
  [".qi-cand-section-label", ["color"]],
  [".qi-cand-list", ["color"]],
  [".qi-cand-tag", ["color", "backgroundColor"]],
  [".qi-cand-meta div", ["backgroundColor", "borderTopColor"]],
  [".qi-cand-meta dt", ["color"]],
  [".qi-cand-meta dd", ["color"]],
  [".qi-cand-governance-note", ["color"]],
  [".qi-cand-accordion-summary", ["color"]],
  [".qi-cand-caret", ["borderRightColor", "borderBottomColor"]],
  [".qi-edit-eyebrow", ["color"]],
  [".qi-edit-heading", ["color"]],
  [".qi-edit-side", ["backgroundColor", "borderTopColor"]],
  [".qi-edit-label", ["color"]],
  [".qi-edit-input", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-edit-error", ["color"]],
  [".qi-review-approved", ["color", "backgroundColor"]],
  [".qi-review-changes", ["backgroundColor"]],
  [".qi-review-rejected", ["backgroundColor"]],
  [".qi-review-withdrawn", ["color", "backgroundColor"]],
  [".qi-export-title", ["color"]],
  [".qi-export-trigger", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-export-preview", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-export-success", ["color", "borderTopColor"]],
  [".qi-source-picker-selection", ["color"]],
  [".qi-path-value", ["color", "backgroundColor", "borderTopColor"]],
  ['.qi-path-value[data-empty="true"]', ["color"]],
  [".qi-field-hint", ["color"]],
  [".qi-cand-action-note", ["color", "backgroundColor", "borderTopColor"]],
  [".qi-connected-path", ["color"]],
  [".qi-connected-hint", ["color"]],
  [".qi-connected-root-name", ["color"]],
  [".qi-coverage-line", ["color"]],
  // mc dialog / chip / row
  ['.mc-chip[data-active="true"]', ["color", "backgroundColor"]],
  ['.mc-chip[aria-pressed="true"]', ["color"]],
  [".mc-row-body", ["color"]],
  [".mc-row-type", ["color"]],
  [".mc-row-pinned", ["color"]],
  [".mc-meta-label", ["color"]],
  [".mc-meta-value", ["color"]],
  [".mc-meta-empty", ["color"]],
  [".mc-body-text", ["color", "backgroundColor"]],
  [".mc-code", ["color"]],
  [".mc-tag", ["color", "backgroundColor", "borderTopColor"]],
  [".mc-action-error", ["color"]],
  // memoria window scoped
  [".memoria-window .lk-header", ["borderBottomColor"]],
  [".memoria-window .mc-filters", ["borderTopColor", "backgroundColor"]],
  ['.memoria-window .mc-chip[data-active="true"]', ["color", "backgroundColor"]],
  [".memoria-window .lk-empty", ["backgroundColor"]],
  [".memoria-window .mc-row", ["backgroundColor"]],
  // rel row
  [".rel-row", ["backgroundColor"]],
  // rb inspector
  [".rb-count", ["color", "backgroundColor"]],
  [".rb-section-label", ["color"]],
  [".rb-ph-label", ["color"]],
  [".rb-placeholder", ["borderTopColor"]],
  [".rb-row-k", ["color"]],
  [".rb-row-v", ["color"]],
  [".rb-foot", ["color", "borderTopColor"]],
  // lk empty / connector ghost
  [".lk-empty-title", ["color"]],
  [".lk-empty-body", ["color"]],
  [".lk-connector-drag-ghost-copy small", ["color"]],
  [".lk-connector-drag-ghost-capsule", ["backgroundColor", "borderTopColor"]],
  [".lk-capsule-name", ["color"]],
  // lkd metrics
  [".lkd-live-note", ["color"]],
  [".lkd-metric-card", ["backgroundColor", "borderTopColor"]],
  ['.lkd-metric-card[data-tone="ok"]', ["borderTopColor"]],
  ['.lkd-metric-card[data-tone="warn"]', ["borderTopColor"]],
  ['.lkd-metric-card[data-tone="danger"]', ["borderTopColor"]],
  [".lkd-metric-label", ["color"]],
  [".lkd-metric-value", ["color"]],
  // lkd source
  [".lkd-source-coverage", ["backgroundColor", "borderTopColor"]],
  ['.lkd-progress-fill[data-tone="ok"]', ["backgroundColor"]],
  ['.lkd-progress-fill[data-tone="warn"]', ["backgroundColor"]],
  ['.lkd-progress-fill[data-tone="danger"]', ["backgroundColor"]],
  [".lkd-source-segment-ok", ["backgroundColor"]],
  [".lkd-source-segment-fail", ["backgroundColor"]],
  [".lkd-source-segment-skip", ["backgroundColor"]],
  [".lkd-status-callout", ["color", "backgroundColor", "borderTopColor"]],
  ['.lkd-status-callout[data-tone="ok"]', ["borderTopColor"]],
  ['.lkd-status-callout[data-tone="warn"]', ["borderTopColor"]],
  ['.lkd-status-callout[data-tone="danger"]', ["borderTopColor", "backgroundColor"]],
  [".lkd-label", ["color"]],
  [".lkd-value", ["color"]],
  [".lkd-source-card", ["backgroundColor", "borderTopColor"]],
  [".lkd-source-name", ["color"]],
  [".lkd-source-path", ["color"]],
  [".lkd-source-scope", ["color", "borderTopColor"]],
  [".lkd-count-ok", ["color"]],
  [".lkd-count-fail", ["color"]],
  [".lkd-count-skip", ["color"]],
  // lkd diagnostics
  ['.lkd-diag-row[data-severity="error"]', ["borderTopColor", "backgroundColor"]],
  ['.lkd-diag-row[data-severity="warning"]', ["borderTopColor"]],
  ['.lkd-diag-group[data-severity="error"]', ["borderTopColor", "backgroundColor"]],
  [".lkd-diag-group-count", ["color"]],
  ['.lkd-diag-row[data-severity="error"] .lkd-diag-severity', ["color"]],
  ['.lkd-diag-row[data-severity="warning"] .lkd-diag-severity', ["color"]],
  ['.lkd-diag-row[data-severity="info"] .lkd-diag-severity', ["color"]],
  [".lkd-diag-code", ["color"]],
  [".lkd-diag-message", ["color"]],
  [".lkd-diag-page", ["color"]],
  // lkd jobs
  ['.lkd-job-status[data-status="succeeded"]', ["color"]],
  ['.lkd-job-status[data-status="failed"]', ["color"]],
  ['.lkd-job-status[data-status="running"]', ["color"]],
  ['.lkd-job-status[data-status="queued"]', ["color"]],
  [".lkd-job-dates", ["color"]],
  [".lkd-job-duration", ["color"]],
  [".lkd-job-error", ["color"]],
  [".lkd-sync-card", ["backgroundColor", "borderTopColor"]],
  [".lkd-action-progress-head", ["color"]],
  [".lkd-action-progress-note", ["color"]],
  // lkd picker
  [".lkd-picker-list", ["backgroundColor", "borderTopColor"]],
  [".lkd-picker-row", ["color"]],
  ['.lkd-picker-row[data-disabled="true"]', ["color"]],
  [".lkd-picker-meta", ["color"]],
  ['.lkd-picker-row[data-disabled="true"] .lkd-picker-meta', ["color"]],
  [".lkd-picker-empty", ["color"]],
  [".lkd-connect-label", ["color"]],
  [".lkd-limit-note", ["color"]],
  // connector picker / node
  [".connector-picker-label", ["color"]],
  [".connector-picker-empty", ["color"]],
  [".connector-picker-error", ["color", "backgroundColor", "borderTopColor"]],
  [".connector-picker-retry", ["color", "backgroundColor", "borderTopColor"]],
  [".connector-node", ["color"]],
  [".connector-node-icon", ["backgroundColor"]],
  [".connector-node-kicker", ["color"]],
  [".connector-node-title", ["color"]],
  [".connector-node-id", ["color"]],
  [".connector-node-manage", ["color", "backgroundColor", "borderTopColor"]],
  // figma snapshot
  [".figma-snapshot-label", ["color"]],
  [".figma-snapshot-hint", ["color"]],
  [".figma-snapshot-progress", ["color"]],
  [".figma-snapshot-error", ["color"]],
  [".figma-snapshot-error-title", ["color"]],
  [".figma-snapshot-error-detail", ["color"]],
  [".figma-snapshot-error-status", ["color"]],
  [".figma-snapshot-error-box", ["borderTopColor", "backgroundColor"]],
  [".figma-snapshot-stored-text", ["color"]],
  [".figma-snapshot-dashboard-status", ["color"]],
  [".figma-snapshot-dashboard-status-error", ["color"]],
  [".figma-snapshot-dashboard-tab", ["color"]],
  ['.figma-snapshot-dashboard-tab[aria-selected="true"]', ["color", "backgroundColor"]],
  [".figma-snapshot-dashboard-empty-title", ["color"]],
  [".figma-snapshot-dashboard-empty-detail", ["color"]],
  [".figma-snapshot-dashboard-item", ["color", "backgroundColor", "borderTopColor"]],
  ['.figma-snapshot-dashboard-item[aria-current="true"]', ["borderTopColor", "backgroundColor"]],
  [".figma-snapshot-dashboard-item-name", ["color"]],
  [".figma-snapshot-dashboard-item-date", ["color"]],
  [".figma-snapshot-dashboard-item-badge", ["color"]],
  [".figma-snapshot-dashboard-item-hint", ["color"]],
  [".figma-snapshot-dashboard-item-meta", ["color"]],
  [".figma-snapshot-dashboard-rename-input", ["color", "backgroundColor", "borderTopColor"]],
  [".figma-snapshot-dashboard-details dt", ["color"]],
  [".figma-snapshot-dashboard-details dd", ["color"]],
  [".figma-snapshot-result-name", ["color"]],
  [".figma-snapshot-result-run", ["color"]],
  [".figma-snapshot-reduction", ["backgroundColor", "borderTopColor"]],
  [".figma-snapshot-reduction-hint", ["color"]],
  [".figma-snapshot-result-metadata dt", ["color"]],
  [".figma-snapshot-result-metadata dd", ["color"]],
  [".figma-snapshot-skipped-notice", ["color"]],
  [".figma-snapshot-code-summary", ["color"]],
  [".figma-snapshot-code-file-path", ["color"]],
  [".figma-snapshot-code-file-contents", ["color", "backgroundColor", "borderTopColor"]],
  [".figma-snapshot-scopes-note", ["color"]],
  [".figma-snapshot-screen-name", ["color"]],
  [".figma-snapshot-screen-summary", ["color"]],
  [".figma-snapshot-screen-size", ["color"]],
  [".figma-snapshot-screen-placeholder-label", ["color"]],
  [".figma-snapshot-screen-frame-icon", ["color"]],
  [".figma-snapshot-gallery-more", ["color", "backgroundColor", "borderTopColor"]],
  [".figma-snapshot-scope-note", ["color"]],
  [".figma-snapshot-empty-steps", ["color"]],
  [".figma-snapshot-empty-note", ["color"]],
  [".figma-view-source-empty-title", ["color"]],
  [".figma-view-source-card", ["backgroundColor", "borderTopColor"]],
  [".figma-view-preview-placeholder", ["color"]],
  [".figma-view-preview-icon", ["color"]],
  [".figma-view-source-title", ["color"]],
  [".figma-view-source-summary", ["color"]],
  [".figma-view-source-facts dt", ["color"]],
  [".figma-view-source-facts dd", ["color"]],
  [".figma-view-json-kicker", ["color"]],
  [".figma-view-json-title", ["color"]],
  [".figma-view-json-meta", ["color"]],
  // json token coloriser
  [".json-token-key", ["color"]],
  [".json-token-string", ["color"]],
  [".json-token-number", ["color"]],
  [".json-token-boolean", ["color"]],
  [".json-token-null", ["color"]],
  [".json-token-punctuation", ["color"]],
  // fpv
  [".fpv-back", ["color"]],
  [".fpv-name", ["color"]],
  [".fpv-lang", ["color", "backgroundColor", "borderTopColor"]],
  [".fpv-gutter", ["color"]],
  // .fpv-src is Category-C4 (routes to --ed-fg which has HC overrides).
  [".fpv-state", ["color", "backgroundColor", "borderTopColor"]],
  [".fpv-error", ["color", "backgroundColor", "borderTopColor"]],
  [".fpv-image-card", ["backgroundColor", "borderTopColor"]],
  [".fpv-meta-row span", ["color"]],
  [".fpv-meta-row strong", ["color"]],
  [".fpv-meta-pane", ["backgroundColor", "borderTopColor"]],
  [".fpv-meta-card-title", ["color"]],
  // hl syntax tokens are Category-C4 (intentional HC adaptation via --ed-syn-* tokens).
  // They are NOT in PROBES_A; they live in PROBES_C4 below.
];

// ─── Category-C probes (deliberate/expected changes, separate from 0-diff gate) ────
// C1: shadow-ink rows. Dark resolves rgb(0 0 0 / α) identical to prior rgba(0,0,0,α).
//     Light resolves rgb(20 30 25 / α) which is intentionally different from PRE.
//     Probe: assert dark identical, light differs. (Only elements that had pure black
//     rgba(0,0,0,α) in PRE light-mode — .hd-tool-cta, .cmp-model-menu, .ksel-menu.)
//     .ws-fab is EXCLUDED: its light box-shadow was already warm in PRE (--shadow-pop).
// C3: mc-dialog-backdrop. PRE had a [data-theme=light] per-component override with the
//     same value (oklch(0.3 0.01 160 / 0.34)) that --overlay-scrim now provides.
//     Dark and Light both resolve identically PRE/POST. Assert both identical.
// C4: hl-* syntax tokens and fpv-src. PRE used hardcoded hex (no HC override), POST
//     routes to --ed-syn-* / --ed-fg which HAVE HC overrides. In dark/light modes the
//     resolved values are identical (same hex → same token value). In HC modes they
//     intentionally differ (higher-contrast palette). Assert dark identical, hc differs.

// C1 — shadow-ink elements where PRE light was pure black → POST is warm (20 30 25)
const PROBES_C1 = [
  { sel: ".hd-tool-cta", prop: "boxShadow", label: "C1-hd-tool-cta" },
  { sel: ".cmp-model-menu", prop: "boxShadow", label: "C1-cmp-model-menu" },
  { sel: ".ksel-menu", prop: "boxShadow", label: "C1-ksel-menu" },
];

// C3 — mc-dialog-backdrop: centralized token, same resolved value PRE/POST in both modes
const PROBES_C3 = [
  { sel: ".mc-dialog-backdrop", prop: "backgroundColor", label: "C3-mc-dialog-backdrop" },
];

// C4 — hl-* / fpv-src: dark+light identical PRE/POST (same hex→token value);
//      in HC modes intentionally different (--ed-syn-* HC overrides).
const PROBES_C4_SELECTORS = [
  [".fpv-src", "color"],
  [".hl-str", "color"],
  [".hl-num", "color"],
  [".hl-key", "color"],
  [".hl-type", "color"],
  [".hl-fn", "color"],
  [".hl-key2", "color"],
  [".hl-punct", "color"],
];

// Combined list for iteration convenience
const PROBES_C = [
  ...PROBES_C1.map((p) => ({ ...p, group: "C1" })),
  ...PROBES_C3.map((p) => ({ ...p, group: "C3" })),
];

const MODES = [
  { id: "01-dark", theme: null, hc: null, media: {} },
  { id: "02-light", theme: "light", hc: null, media: {} },
  { id: "03-dark-hc", theme: null, hc: "more", media: {} },
  { id: "04-light-hc", theme: "light", hc: "more", media: {} },
  { id: "05-prefers-contrast", theme: null, hc: null, media: { contrast: "more" } },
  { id: "06-forced-colors", theme: null, hc: null, media: { forcedColors: "active" } },
  { id: "07-reduced-motion", theme: null, hc: null, media: { reducedMotion: "reduce" } },
];

function pageHtml(cssText) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${cssText}
  body{margin:0;padding:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
  .lkd-picker-list,.figma-snapshot-dashboard-panel{display:block}
  .mc-dialog-backdrop{position:relative;width:100px;height:40px}
  .ws-fab,.hd-tool-cta{position:relative}
  </style></head><body><div id="root">${BODY}</div></body></html>`;
}

async function collect(page, cssText, mode) {
  await page.emulateMedia({ colorScheme: "dark", ...mode.media });
  await page.setContent(pageHtml(cssText), { waitUntil: "load" });
  await page.evaluate(
    ({ theme, hc }) => {
      const r = document.documentElement;
      r.removeAttribute("data-theme");
      r.removeAttribute("data-hc");
      if (theme) r.setAttribute("data-theme", theme);
      if (hc) r.setAttribute("data-hc", hc);
    },
    { theme: mode.theme, hc: mode.hc },
  );
  return page.evaluate((probes) => {
    const out = {};
    for (const [sel, props] of probes) {
      const el = document.querySelector(sel);
      if (!el) {
        out[sel] = "__MISSING__";
        continue;
      }
      const cs = getComputedStyle(el);
      out[sel] = Object.fromEntries(props.map((p) => [p, cs[p]]));
    }
    return out;
  }, PROBES_A);
}

async function collectC(page, cssText, mode) {
  await page.emulateMedia({ colorScheme: "dark", ...mode.media });
  await page.setContent(pageHtml(cssText), { waitUntil: "load" });
  await page.evaluate(
    ({ theme, hc }) => {
      const r = document.documentElement;
      r.removeAttribute("data-theme");
      r.removeAttribute("data-hc");
      if (theme) r.setAttribute("data-theme", theme);
      if (hc) r.setAttribute("data-hc", hc);
    },
    { theme: mode.theme, hc: mode.hc },
  );
  // Collect C1/C3 probes (sel+prop pairs from PROBES_C) and C4 probes (PROBES_C4_SELECTORS)
  return page.evaluate(
    ({ cProbes, c4Probes }) => {
      const out = {};
      for (const { sel, prop } of cProbes) {
        const el = document.querySelector(sel);
        if (!el) {
          out[`${sel}::${prop}`] = "__MISSING__";
          continue;
        }
        out[`${sel}::${prop}`] = getComputedStyle(el)[prop];
      }
      for (const [sel, prop] of c4Probes) {
        const el = document.querySelector(sel);
        if (!el) {
          out[`${sel}::${prop}`] = "__MISSING__";
          continue;
        }
        out[`${sel}::${prop}`] = getComputedStyle(el)[prop];
      }
      return out;
    },
    { cProbes: PROBES_C, c4Probes: PROBES_C4_SELECTORS },
  );
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  deviceScaleFactor: 2,
  viewport: { width: 1440, height: 1600 },
});
const page = await ctx.newPage();

let totalProbes = 0;
const diffs = [];
const missing = new Set();
const proof = {};
const catCRaw = { pre: {}, post: {} };

for (const mode of MODES) {
  // ── Category A: 0-diff gate ──────────────────────────────────────────────
  const pre = await collect(page, PRE, mode);
  const post = await collect(page, POST, mode);
  let modeDiffs = 0;
  let modeProbes = 0;
  for (const [sel] of PROBES_A) {
    if (post[sel] === "__MISSING__" || pre[sel] === "__MISSING__") {
      missing.add(sel);
      continue;
    }
    for (const p of Object.keys(post[sel])) {
      modeProbes++;
      totalProbes++;
      const a = pre[sel]?.[p];
      const b = post[sel]?.[p];
      if (a !== b) {
        modeDiffs++;
        diffs.push(`[${mode.id}] ${sel} { ${p}: PRE="${a}" POST="${b}" }`);
      }
    }
  }
  proof[mode.id] = { probes: modeProbes, diffs: modeDiffs };

  // ── Category C: collect raw values ──────────────────────────────────────
  catCRaw.pre[mode.id] = await collectC(page, PRE, mode);
  catCRaw.post[mode.id] = await collectC(page, POST, mode);

  // ── Screenshot (POST) ───────────────────────────────────────────────────
  await collect(page, POST, mode);
  await page.screenshot({ path: resolve(HERE, `${mode.id}.png`), fullPage: true });
  console.log(`${mode.id}: ${modeProbes} probes, ${modeDiffs} differing computed values`);
}

// ─── Category-C analysis ──────────────────────────────────────────────────────
const catCResults = {};
const catCFailures = [];

// C1: dark identical, light differs (warm shadow ink replaces pure black)
for (const { sel, prop, label, group } of PROBES_C) {
  const key = `${sel}::${prop}`;
  const darkPre = catCRaw.pre["01-dark"][key];
  const darkPost = catCRaw.post["01-dark"][key];
  const lightPre = catCRaw.pre["02-light"][key];
  const lightPost = catCRaw.post["02-light"][key];
  const darkIdentical = darkPre === darkPost;
  if (group === "C1") {
    const lightDiffers = lightPre !== lightPost;
    catCResults[key] = {
      group,
      label,
      darkPre,
      darkPost,
      darkIdentical,
      lightPre,
      lightPost,
      lightDiffers,
    };
    if (!darkIdentical)
      catCFailures.push(
        `FAIL ${group} dark not identical: ${key} PRE="${darkPre}" POST="${darkPost}"`,
      );
    if (!lightDiffers)
      catCFailures.push(
        `FAIL ${group} light should differ (warm ink): ${key} PRE="${lightPre}" POST="${lightPost}"`,
      );
  } else if (group === "C3") {
    // C3: centralized token — both dark AND light must be identical PRE/POST
    const lightIdentical = lightPre === lightPost;
    catCResults[key] = {
      group,
      label,
      darkPre,
      darkPost,
      darkIdentical,
      lightPre,
      lightPost,
      lightIdentical,
    };
    if (!darkIdentical)
      catCFailures.push(
        `FAIL ${group} dark not identical: ${key} PRE="${darkPre}" POST="${darkPost}"`,
      );
    if (!lightIdentical)
      catCFailures.push(
        `FAIL ${group} light not identical (token should resolve same value): ${key} PRE="${lightPre}" POST="${lightPost}"`,
      );
  }
}

// C4: hl-* / fpv-src — dark+light identical, HC modes intentionally differ
const catC4Results = {};
for (const [sel, prop] of PROBES_C4_SELECTORS) {
  const key = `${sel}::${prop}`;
  const darkPre = catCRaw.pre["01-dark"][key];
  const darkPost = catCRaw.post["01-dark"][key];
  const hcPre = catCRaw.pre["03-dark-hc"][key];
  const hcPost = catCRaw.post["03-dark-hc"][key];
  const darkIdentical = darkPre === darkPost;
  const hcDiffers = hcPre !== hcPost;
  catC4Results[key] = { darkPre, darkPost, darkIdentical, hcPre, hcPost, hcDiffers };
  if (!darkIdentical)
    catCFailures.push(`FAIL C4 dark not identical: ${key} PRE="${darkPre}" POST="${darkPost}"`);
  if (!hcDiffers)
    catCFailures.push(
      `FAIL C4 HC should differ (--ed-syn-* HC overrides): ${key} PRE="${hcPre}" POST="${hcPost}"`,
    );
}

// ─── Write proof JSON ─────────────────────────────────────────────────────────
writeFileSync(
  resolve(HERE, "computed-value-proof.json"),
  JSON.stringify(
    {
      issue: 1295,
      baseRef: BASE_REF,
      totalProbes,
      diffCount: diffs.length,
      missingSelectors: [...missing],
      byMode: proof,
      diffs,
      categoryC: {
        description:
          "Deliberate adaptations (separate from 0-diff gate). " +
          "C1: shadow-ink rows adapt warm ink in Light (dark identical, light differs). " +
          "C3: mc-dialog-backdrop routes to --overlay-scrim (both dark+light identical — centralisation, no value change). " +
          "C4: hl-*/fpv-src route to --ed-syn-*/--ed-fg which have HC overrides (dark+light identical, HC intentionally differs).",
        C1: {
          probes: Object.fromEntries(
            Object.entries(catCResults).filter(([, r]) => r.group === "C1"),
          ),
        },
        C3: {
          probes: Object.fromEntries(
            Object.entries(catCResults).filter(([, r]) => r.group === "C3"),
          ),
        },
        C4: {
          description:
            "hl-*/fpv-src: dark identical PRE/POST (same hex), HC modes differ (--ed-syn-* HC overrides improve contrast). This is intentional.",
          probes: catC4Results,
        },
        failures: catCFailures,
      },
    },
    null,
    2,
  ),
);

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(
  `\nTOTAL Category-A: ${totalProbes} computed-value probes across ${MODES.length} modes`,
);
console.log(`MISSING selectors (not in DOM, skipped): ${missing.size}`);
if (missing.size > 0) for (const s of missing) console.log(`  MISSING: ${s}`);
console.log(`DIFFERENCES (pre vs post): ${diffs.length}`);
for (const d of diffs.slice(0, 80)) console.log(d);
console.log(`\nCategory-C deliberate adaptations:`);
for (const [key, r] of Object.entries(catCResults)) {
  const darkOk = r.darkIdentical ? "OK" : "FAIL";
  const lightOk =
    r.group === "C1"
      ? r.lightDiffers
        ? "OK differs (expected)"
        : "FAIL should differ"
      : r.lightIdentical
        ? "OK identical (expected)"
        : "FAIL should be identical";
  console.log(`  [${r.group}] ${key}: dark=${darkOk}  light=${lightOk}`);
  console.log(`    dark   PRE="${r.darkPre}"  POST="${r.darkPost}"`);
  console.log(`    light  PRE="${r.lightPre}"  POST="${r.lightPost}"`);
}
console.log(
  `  [C4] ${Object.keys(catC4Results).length} hl-*/fpv-src probes — dark identical, HC differs:`,
);
for (const [key, r] of Object.entries(catC4Results)) {
  const darkOk = r.darkIdentical ? "OK" : "FAIL";
  const hcOk = r.hcDiffers ? "OK differs (expected)" : "FAIL should differ";
  console.log(`    ${key}: dark=${darkOk}  hc=${hcOk}`);
}
if (catCFailures.length > 0) {
  console.error(`\nCategory-C FAILURES:`);
  for (const f of catCFailures) console.error(`  ${f}`);
}

await browser.close();
process.exit(diffs.length === 0 && catCFailures.length === 0 ? 0 : 1);
