// AC9 inspects the existing human Chat; it never submits a turn or writes to Jira.
import assert from "node:assert/strict";
import { URL, URLSearchParams } from "node:url";
import { canonicalise } from "@oscharko-dev/keiko-contracts/runtime/canonical-json";
import { sha256 } from "../../lib/digest.mjs";
import { compareStrings } from "../../lib/compare-strings.mjs";
import { runAxe, seriousOrCritical } from "../../../tests/e2e/support/axe.ts";
import { openLimitStep } from "./limit-run-step.mjs";
import { changeLimitUiLanguage } from "./limit-run-language.mjs";
import { resolveLimitBrowser } from "./limit-run-browser.mjs";
import { nativePages, projectAgileRead } from "./project-agile-oracles.mjs";
import { RESULT_CARDS, cardTextFindings } from "./browser-card-readability.mjs";

const hash = (value) => sha256(canonicalise(value));
const sortedSet = (values) => [...new Set(values)].sort(compareStrings);

class CardFailure extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}
function demand(condition, detail = "cards-readability-failed") {
  if (!condition) throw new CardFailure(detail);
}
async function begin(journal) {
  if (journal.state.phase === "prepared") await journal.checkpoint({ phase: "pending" });
}

/** Repeated explicit calls apply the requested ordinary Settings control to the current UI. */
export async function setUiLanguage(ctx, locale) {
  assert.ok(locale === "en" || locale === "de", "Unsupported limit-run UI language");
  const journal = await openLimitStep(ctx, `ac9-ui-language-${locale}`);
  let changes = 0;
  try {
    await begin(journal);
    changes = Number((await ctx.page.locator("html").getAttribute("lang")) !== locale);
    await changeLimitUiLanguage(ctx, locale);
    assert.equal(await ctx.page.locator("html").getAttribute("lang"), locale);
    await journal.checkpoint({ phase: "completed", resources: { locale }, counts: { changes } });
    return journal.result("green", "ui-language-confirmed", { changes });
  } catch {
    return journal.result(
      "unverified",
      ctx.signal.aborted ? "ui-language-aborted" : "ui-language-unavailable",
      { changes },
    );
  }
}

function visibleIssueKeys(text, links, projectKey) {
  const pattern = new RegExp(`\\b${projectKey}-[1-9]\\d*\\b`, "gu");
  const keys = text.match(pattern) ?? [];
  for (const link of links) {
    const path = new URL(link).pathname;
    if (path.includes("/browse/")) keys.push(...(path.match(pattern) ?? []));
  }
  return keys;
}
async function cardLinks(card, origin) {
  const locator = card.getByRole("link");
  const links = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    const link = locator.nth(index);
    if (!(await link.isVisible())) continue;
    const href = await link.getAttribute("href");
    demand(typeof href === "string" && href.length > 0);
    const url = new URL(href, origin);
    demand(
      new Set(["http:", "https:"]).has(url.protocol) && url.username === "" && url.password === "",
    );
    links.push(url.href);
  }
  return links;
}
async function readableCard(card, origin, projectKey) {
  const title = (await card.locator(":scope > strong").innerText()).trim();
  const outcome = (await card.locator(":scope > output").innerText()).trim();
  const text = await card.innerText();
  demand(title.length > 0 && outcome.length > 0);
  const findings = cardTextFindings({ title, text, preCount: await card.locator("pre").count() });
  demand(Object.values(findings).every((count) => count === 0));
  const links = await cardLinks(card, origin);
  return { title, outcome, keys: visibleIssueKeys(text, links, projectKey), links };
}
async function visibleCards(browser, projectKey) {
  const locator = browser.region.locator(RESULT_CARDS);
  const cards = [];
  for (let index = 0; index < (await locator.count()); index += 1) {
    const card = locator.nth(index);
    if (await card.isVisible())
      cards.push(await readableCard(card, browser.page.url(), projectKey));
  }
  demand(cards.length > 0);
  return {
    cards: cards.map(({ title, outcome }) => ({ title, outcome })),
    keys: sortedSet(cards.flatMap((card) => card.keys)),
    links: sortedSet(cards.flatMap((card) => card.links)),
  };
}
async function boundNativeIssues(ctx, keys) {
  const observed = [];
  for (let offset = 0; offset < keys.length; offset += 50) {
    const batch = keys.slice(offset, offset + 50);
    const query = new URLSearchParams({
      jql: `project = ${ctx.projectKey} AND key in (${batch.map((key) => `"${key}"`).join(",")}) ORDER BY key ASC`,
      fields: "*all",
    });
    const issues = await nativePages(
      (path) => projectAgileRead(ctx.session, path),
      `/rest/api/2/search?${query}`,
      "issues",
    );
    demand(
      issues.length === batch.length &&
        hash(sortedSet(issues.map((issue) => issue.key))) === hash(batch),
    );
    for (const issue of issues) demand(issue.fields?.project?.key === ctx.projectKey);
    observed.push(...issues);
  }
  return observed.sort((left, right) => compareStrings(left.key, right.key));
}
async function history(browser) {
  const query = new URLSearchParams({
    chatId: browser.chat.id,
    projectPath: browser.chat.projectPath,
  });
  const response = await browser.page.request.get(`/api/chats/messages?${query}`);
  assert.equal(response.status(), 200);
  const value = await response.json();
  assert.ok(Array.isArray(value.messages) && value.messages.length > 0);
  return hash(value);
}
async function accessibility(browser, counts) {
  const id = await browser.region.getAttribute("data-window-id");
  assert.match(id, /^[A-Za-z\d_-]{1,128}$/u);
  const violations = seriousOrCritical(
    await runAxe(browser.page, `.window[data-window-id="${id}"]`),
  );
  counts.serious += violations.filter((value) => value.impact === "serious").length;
  counts.critical += violations.filter((value) => value.impact === "critical").length;
  demand(violations.length === 0, "cards-accessibility-failed");
}
async function observe(ctx, browser, counts) {
  ctx.signal.throwIfAborted();
  const visible = await visibleCards(browser, ctx.projectKey);
  counts.cards = visible.cards.length;
  counts.keys = visible.keys.length;
  counts.links = visible.links.length;
  await accessibility(browser, counts);
  return {
    visible,
    native: await boundNativeIssues(ctx, visible.keys),
    history: await history(browser),
  };
}
function watchChatWrites(page, counts) {
  const origin = new URL(page.url()).origin;
  const listener = (request) => {
    if (new Set(["GET", "HEAD", "OPTIONS"]).has(request.method())) return;
    const url = new URL(request.url());
    if (
      url.origin === origin &&
      /^\/api\/(?:chats(?:\/|$)|desktop\/chats?(?:\/|$))/u.test(url.pathname)
    )
      counts.chatWrites += 1;
  };
  page.on("request", listener);
  return () => page.off("request", listener);
}
function compareReload(before, after, firstChat, nextChat, counts) {
  demand(firstChat === nextChat, "cards-reload-changed");
  demand(counts.chatWrites === 0 && before.history === after.history, "cards-reload-replayed");
  demand(
    hash(before.visible) === hash(after.visible) && hash(before.native) === hash(after.native),
    "cards-reload-changed",
  );
}
async function auditCards(ctx, options, journal, counts) {
  const browser = await resolveLimitBrowser(ctx);
  const stop = watchChatWrites(browser.page, counts);
  try {
    const before = await observe(ctx, browser, counts);
    if (options.reload) {
      ctx.signal.throwIfAborted();
      counts.reloads += 1;
      await browser.page.reload();
      await browser.region.waitFor({ state: "visible" });
      await browser.region.locator(RESULT_CARDS).first().waitFor({ state: "visible" });
      const restored = await resolveLimitBrowser(ctx);
      const after = await observe(ctx, restored, counts);
      compareReload(before, after, browser.chat.id, restored.chat.id, counts);
    }
    demand(counts.chatWrites === 0, "cards-reload-replayed");
    await journal.checkpoint({
      phase: "completed",
      counts,
      resources: {
        chatId: browser.chat.id,
        cardDigest: hash({ visible: before.visible, native: before.native }),
        keyDigest: hash(before.visible.keys),
        linkDigest: hash(before.visible.links),
      },
    });
    return journal.result("green", "cards-readable-confirmed", counts);
  } finally {
    stop();
  }
}

/** Current visible card scope only: zero severe axe findings, stable reload and no replay. */
export async function assertCardsReadable(ctx, options = {}) {
  assert.ok(
    options.reload === undefined || typeof options.reload === "boolean",
    "Invalid card reload option",
  );
  const journal = await openLimitStep(ctx, "ac9-cards-readable");
  const counts = {
    cards: 0,
    keys: 0,
    links: 0,
    serious: 0,
    critical: 0,
    chatWrites: 0,
    reloads: 0,
  };
  try {
    await begin(journal);
    return await auditCards(ctx, options, journal, counts);
  } catch (error) {
    if (ctx.signal.aborted) return journal.result("unverified", "cards-readable-aborted", counts);
    if (error instanceof CardFailure) return journal.result("red", error.detail, counts);
    return journal.result("unverified", "cards-readback-unavailable", counts);
  }
}
