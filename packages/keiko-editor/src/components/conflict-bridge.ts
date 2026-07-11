import type { ConflictBlock, ConflictChoice } from "./conflict-markers.js";
import { conflictReplacement, parseConflictMarkers } from "./conflict-markers.js";

export interface ConflictLabels {
  readonly next: string;
  readonly previous: string;
  readonly ours: string;
  readonly theirs: string;
  readonly both: string;
}

export interface ConflictModel {
  getValue(): string;
  getVersionId(): number;
  getPositionAt(offset: number): { readonly lineNumber: number; readonly column: number };
  onDidChangeContent(listener: () => void): { dispose(): void };
}

export interface ConflictEditor {
  getModel(): ConflictModel | null;
  getPosition(): { readonly lineNumber: number; readonly column: number } | null;
  setPosition(position: { readonly lineNumber: number; readonly column: number }): void;
  revealRangeInCenterIfOutsideViewport(range: MonacoConflictRange): void;
  deltaDecorations(oldIds: string[], decorations: readonly ConflictDecoration[]): string[];
  addAction(descriptor: ConflictAction): { dispose(): void };
  executeEdits(
    source: string,
    edits: readonly { readonly range: MonacoConflictRange; readonly text: string }[],
  ): boolean;
  pushUndoStop(): boolean;
}

export interface MonacoConflictRange {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

interface ConflictDecoration {
  readonly range: MonacoConflictRange;
  readonly options: {
    readonly isWholeLine: true;
    readonly className: string;
    readonly linesDecorationsClassName: string;
  };
}

interface ConflictAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

interface ConflictAcceptanceTarget {
  readonly conflict: ConflictBlock;
  readonly expected: string;
  readonly model: ConflictModel;
  readonly text: string;
}

export interface ConflictBridge {
  next(): void;
  previous(): void;
  accept(choice: ConflictChoice): Promise<void>;
  dispose(): void;
}

export interface RegisterConflictBridgeArgs {
  readonly editor: ConflictEditor;
  readonly labels: ConflictLabels;
  readonly onChange: (count: number, truncated: boolean) => void;
  readonly onStale?: (() => void) | undefined;
  readonly debounceMs?: number | undefined;
  readonly digest?: ((value: string) => Promise<string>) | undefined;
}

const ENCODER = new TextEncoder();

async function digest(value: string): Promise<string> {
  const bytes = ENCODER.encode(value);
  const cryptoLike = (globalThis as { readonly crypto?: Crypto }).crypto;
  if (cryptoLike?.subtle === undefined) throw new Error("SHA-256 unavailable");
  const hash = await cryptoLike.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function token(
  text: string,
  conflict: ConflictBlock,
  hash: (value: string) => Promise<string>,
): Promise<string> {
  return hash(
    `${String(conflict.range.start)}:${String(conflict.range.end)}:${text.slice(conflict.range.start, conflict.range.end)}`,
  );
}

function monacoRange(model: ConflictModel, start: number, end: number): MonacoConflictRange {
  const from = model.getPositionAt(start);
  const to = model.getPositionAt(end);
  return {
    startLineNumber: from.lineNumber,
    startColumn: from.column,
    endLineNumber: to.lineNumber,
    endColumn: to.column,
  };
}

function decorations(
  model: ConflictModel,
  blocks: readonly ConflictBlock[],
): readonly ConflictDecoration[] {
  return blocks.flatMap((entry) =>
    ([entry.ours, entry.base, entry.theirs] as const).flatMap((part, index) =>
      part === null
        ? []
        : [
            {
              range: monacoRange(model, part.start, part.end),
              options: {
                isWholeLine: true,
                className: `keiko-conflict-region-${String(index)}`,
                linesDecorationsClassName: `keiko-conflict-mark-${String(index)}`,
              },
            },
          ],
    ),
  );
}

const RESOLUTIONS = [
  { choice: "ours", id: "keiko.editor.acceptConflictOurs" },
  { choice: "theirs", id: "keiko.editor.acceptConflictTheirs" },
  { choice: "both", id: "keiko.editor.acceptConflictBoth" },
] as const;

class ConflictController implements ConflictBridge {
  private blocks: readonly ConflictBlock[] = [];
  private tokens: readonly string[] = [];
  private version = -1;
  private model: ConflictModel | null = null;
  private decorationIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private disposed = false;
  private readonly actions: readonly { dispose(): void }[];
  private readonly contentSub: { dispose(): void } | null;

  constructor(private readonly args: RegisterConflictBridgeArgs) {
    this.actions = this.installActions();
    this.contentSub =
      args.editor.getModel()?.onDidChangeContent(() => {
        this.schedule();
      }) ?? null;
    this.schedule(0);
  }

  private async scan(): Promise<void> {
    const current = this.args.editor.getModel();
    const run = ++this.generation;
    if (current === null) return;
    const text = current.getValue();
    const parsed = parseConflictMarkers(text);
    const nextTokens = await Promise.all(
      parsed.conflicts.map((entry) => token(text, entry, this.args.digest ?? digest)),
    );
    if (this.disposed || run !== this.generation || current !== this.args.editor.getModel()) return;
    this.model = current;
    this.version = current.getVersionId();
    this.blocks = parsed.conflicts;
    this.tokens = nextTokens;
    this.decorationIds = this.args.editor.deltaDecorations(
      this.decorationIds,
      decorations(current, this.blocks),
    );
    this.args.onChange(parsed.total, parsed.truncated || parsed.malformed);
  }

  private schedule(delay = this.args.debounceMs ?? 120): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan().catch(() => {
        this.args.onChange(0, true);
      });
    }, delay);
  }

  private currentIndex(): number {
    const line = this.args.editor.getPosition()?.lineNumber ?? 0;
    return this.blocks.findIndex(
      (entry) => line >= entry.range.startLine && line <= entry.range.endLine,
    );
  }

  private navigate(step: 1 | -1): void {
    if (this.blocks.length === 0 || this.model === null) return;
    const current = this.currentIndex();
    const index =
      current < 0
        ? step === 1
          ? 0
          : this.blocks.length - 1
        : (current + step + this.blocks.length) % this.blocks.length;
    const block = this.blocks[index];
    if (block === undefined) return;
    const range = monacoRange(this.model, block.range.start, block.range.end);
    this.args.editor.setPosition({ lineNumber: range.startLineNumber, column: 1 });
    this.args.editor.revealRangeInCenterIfOutsideViewport(range);
  }

  private acceptanceTarget(): ConflictAcceptanceTarget | null {
    const index = Math.max(0, this.currentIndex());
    const conflict = this.blocks[index];
    const expected = this.tokens[index];
    const model = this.args.editor.getModel();
    if (
      conflict === undefined ||
      expected === undefined ||
      model === null ||
      model !== this.model
    ) {
      return null;
    }
    return { conflict, expected, model, text: model.getValue() };
  }

  private acceptanceIsCurrent(target: ConflictAcceptanceTarget, actual: string): boolean {
    return (
      actual === target.expected &&
      target.model === this.args.editor.getModel() &&
      target.model.getVersionId() === this.version &&
      target.model.getValue() === target.text
    );
  }

  private rejectStale(): void {
    this.args.onStale?.();
    this.schedule(0);
  }

  async accept(choice: ConflictChoice): Promise<void> {
    const target = this.acceptanceTarget();
    if (target === null) return;
    let actual: string;
    try {
      actual = await token(target.text, target.conflict, this.args.digest ?? digest);
    } catch {
      this.rejectStale();
      return;
    }
    if (!this.acceptanceIsCurrent(target, actual)) {
      this.rejectStale();
      return;
    }
    this.args.editor.pushUndoStop();
    this.args.editor.executeEdits("keiko.mergeConflict", [
      {
        range: monacoRange(target.model, target.conflict.range.start, target.conflict.range.end),
        text: conflictReplacement(target.text, target.conflict, choice),
      },
    ]);
    this.args.editor.pushUndoStop();
    this.schedule(0);
  }

  private installActions(): readonly { dispose(): void }[] {
    return [
      this.args.editor.addAction({
        id: "keiko.editor.nextConflict",
        label: this.args.labels.next,
        run: (): void => {
          this.navigate(1);
        },
      }),
      this.args.editor.addAction({
        id: "keiko.editor.previousConflict",
        label: this.args.labels.previous,
        run: (): void => {
          this.navigate(-1);
        },
      }),
      ...RESOLUTIONS.map(({ choice, id }) =>
        this.args.editor.addAction({
          id,
          label: this.args.labels[choice],
          run: async (): Promise<void> => {
            await this.accept(choice);
          },
        }),
      ),
    ];
  }

  next(): void {
    this.navigate(1);
  }

  previous(): void {
    this.navigate(-1);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.contentSub?.dispose();
    for (const action of this.actions) action.dispose();
    this.decorationIds = this.args.editor.deltaDecorations(this.decorationIds, []);
  }
}

export function registerConflictBridge(args: RegisterConflictBridgeArgs): ConflictBridge {
  return new ConflictController(args);
}
