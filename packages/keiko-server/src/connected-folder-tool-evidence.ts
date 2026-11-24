import type {
  ConnectedContextPack,
  ConnectedFileEntry,
  ContextExcerpt,
} from "@oscharko-dev/keiko-contracts/connected-context";
import type { ConnectedFolderToolWindow } from "./connectedFolderTool.js";

// On a folder tool turn the model reads more of the connected folder than the automatic retrieval
// sent. Those lines are evidence of the same folder, admitted by the same scope, so the answer may
// cite them: the citation check, the support check and the evidence manifest read them from the
// sent pack like any other excerpt. A line the model never received stays unsupported.

/** Why a file is in the pack when only the model's own tool read brought it there. */
export const CONNECTED_FOLDER_TOOL_READ_SELECTION_REASON = "model-tool-read";

/** The same lines with the same text: a sent excerpt the prompt fit clipped is not the same. */
function sameLines(left: ContextExcerpt, right: ContextExcerpt): boolean {
  const a = left.atom.lineRange;
  const b = right.atom.lineRange;
  if (a === undefined || b === undefined) return false;
  return a.startLine === b.startLine && a.endLine === b.endLine && left.content === right.content;
}

function toolReadFile(scopePath: string): ConnectedFileEntry {
  return {
    scopePath,
    role: "read-only",
    selectionReason: CONNECTED_FOLDER_TOOL_READ_SELECTION_REASON,
    excerpts: [],
  };
}

/**
 * The sent pack with every line window the model received through the folder tool. A window whose
 * exact lines and text the pack already carries is not added twice. Budget, usage and omissions
 * stay those of the retrieval: the tool's own work is recorded per call on `folder.files.operation`.
 */
export function withConnectedFolderToolEvidence(
  pack: ConnectedContextPack,
  windows: readonly ConnectedFolderToolWindow[],
): ConnectedContextPack {
  if (windows.length === 0) return pack;
  const files = new Map(pack.files.map((file) => [file.scopePath, file]));
  for (const window of windows) {
    const file = files.get(window.path) ?? toolReadFile(window.path);
    const known = file.excerpts.some((excerpt) => sameLines(excerpt, window.excerpt));
    files.set(
      window.path,
      known ? file : { ...file, excerpts: [...file.excerpts, window.excerpt] },
    );
  }
  return { ...pack, files: [...files.values()] };
}

/**
 * What the answer of a grounded turn may cite: the packs that were sent, and on a folder tool turn
 * the tool-read windows merged into the folder's one pack. A turn that sent no pack takes the
 * assembled one without its files as the carrier, so a tool read is the only evidence it grants.
 */
export function answerEvidencePacks(
  sent: readonly ConnectedContextPack[],
  assembled: ConnectedContextPack,
  windows: readonly ConnectedFolderToolWindow[],
): readonly ConnectedContextPack[] {
  if (windows.length === 0) return sent;
  const [first, ...rest] = sent;
  return [withConnectedFolderToolEvidence(first ?? { ...assembled, files: [] }, windows), ...rest];
}

function holdsLines(pack: ConnectedContextPack): boolean {
  return pack.files.some((file) => file.excerpts.some((excerpt) => excerpt.content.length > 0));
}

/**
 * A `no-evidence` marker of the retrieval says the automatic search found nothing. It does not
 * describe an answer that was given lines all the same, which only a folder tool read can do: the
 * marker is dropped then, and every other marker stays.
 */
export function uncertaintyForSentEvidence<T extends { readonly kind: string }>(
  markers: readonly T[],
  sent: readonly ConnectedContextPack[] | undefined,
): readonly T[] {
  if (sent?.some(holdsLines) !== true) return markers;
  if (!markers.some((marker) => marker.kind === "no-evidence")) return markers;
  return markers.filter((marker) => marker.kind !== "no-evidence");
}
