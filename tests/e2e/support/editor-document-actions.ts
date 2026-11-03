/**
 * The editor pane's secondary document actions (#3685).
 *
 * Save stays a primary toolbar button. File history, Format and the Git diff entry live in the
 * "More file actions" disclosure (`EditorDocumentActions`): a native `<details>` whose panel is
 * hidden until the summary is activated, so a role query for one of those buttons resolves nothing
 * while the menu is closed. An action that does not apply to the open file is OMITTED from the
 * panel rather than rendered disabled, so absence is only meaningful once the menu has been opened.
 */
import { expect, type Locator } from "@playwright/test";

const DOCUMENT_ACTIONS_LABEL = "More file actions";

/** The disclosure that owns the pane's secondary actions, addressed through its labelled summary. */
function documentActionsDisclosure(scope: Locator): Locator {
  return scope.locator(`details:has(> summary[aria-label="${DOCUMENT_ACTIONS_LABEL}"])`);
}

/**
 * Opens the "More file actions" disclosure inside `scope` (a pane, or the editor window region) and
 * returns its panel. Idempotent: an already-open disclosure is left alone, because a second click
 * on the summary would close it again.
 */
export async function openDocumentActions(scope: Locator): Promise<Locator> {
  const disclosure = documentActionsDisclosure(scope);
  const alreadyOpen = await disclosure.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!alreadyOpen) {
    await disclosure.locator(`summary[aria-label="${DOCUMENT_ACTIONS_LABEL}"]`).click();
  }
  await expect(disclosure).toHaveJSProperty("open", true);
  return disclosure;
}

/** Closes the disclosure again through its summary, leaving the pane as the caller found it. */
export async function closeDocumentActions(scope: Locator): Promise<void> {
  const disclosure = documentActionsDisclosure(scope);
  if (await disclosure.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await disclosure.locator(`summary[aria-label="${DOCUMENT_ACTIONS_LABEL}"]`).click();
  }
  await expect(disclosure).toHaveJSProperty("open", false);
}

/** Opens the disclosure and returns one of its actions by exact accessible name. */
export async function documentAction(scope: Locator, name: string): Promise<Locator> {
  const panel = await openDocumentActions(scope);
  return panel.getByRole("button", { name, exact: true });
}

/**
 * The Format action must be offered exactly when the formatting source can format the open file,
 * which is the same value the status bar's `formatting` field reads (ADR-0068 D3/D4). Opens the
 * menu first: an unavailable Format is omitted, and a closed menu would make that look identical
 * to a Format action that exists but is hidden. The menu is closed again afterwards so a later
 * step never inherits an open panel.
 */
export async function expectFormatActionAvailability(
  scope: Locator,
  available: boolean,
): Promise<void> {
  const format = await documentAction(scope, "Format");
  if (available) {
    await expect(format).toBeVisible();
    await expect(format).toBeEnabled();
  } else {
    await expect(format).toHaveCount(0);
  }
  await closeDocumentActions(scope);
}
