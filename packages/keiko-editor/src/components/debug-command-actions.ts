import type * as monaco from "monaco-editor";

/** The six bounded debugger controls exposed through Monaco's command palette. */
export type EditorDebugCommandAction =
  "continue" | "pause" | "stepOver" | "stepInto" | "stepOut" | "stop";

export interface EditorDebugCommandHandlers {
  readonly labels?: EditorDebugCommandLabels | undefined;
  readonly isAvailable?: ((action: EditorDebugCommandAction) => boolean) | undefined;
  readonly continue: () => void;
  readonly pause: () => void;
  readonly stepOver: () => void;
  readonly stepInto: () => void;
  readonly stepOut: () => void;
  readonly stop: () => void;
}

export interface EditorDebugCommandLabels {
  readonly continue: string;
  readonly pause: string;
  readonly stepOver: string;
  readonly stepInto: string;
  readonly stepOut: string;
  readonly stop: string;
}

export interface DebugCommandActionKeys {
  readonly KeyMod: { readonly Shift: number };
  readonly KeyCode: {
    readonly F5: number;
    readonly F6: number;
    readonly F10: number;
    readonly F11: number;
  };
}

interface DebugCommandDefinition {
  readonly action: EditorDebugCommandAction;
  readonly id: string;
  readonly keybinding: (keys: DebugCommandActionKeys) => number;
}

const DEBUG_COMMAND_DEFINITIONS: readonly DebugCommandDefinition[] = [
  {
    action: "continue",
    id: "keiko.editor.debugContinue",
    keybinding: (keys): number => keys.KeyCode.F5,
  },
  {
    action: "pause",
    id: "keiko.editor.debugPause",
    keybinding: (keys): number => keys.KeyCode.F6,
  },
  {
    action: "stepOver",
    id: "keiko.editor.debugStepOver",
    keybinding: (keys): number => keys.KeyCode.F10,
  },
  {
    action: "stepInto",
    id: "keiko.editor.debugStepInto",
    keybinding: (keys): number => keys.KeyCode.F11,
  },
  {
    action: "stepOut",
    id: "keiko.editor.debugStepOut",
    keybinding: (keys): number => keys.KeyMod.Shift | keys.KeyCode.F11,
  },
  {
    action: "stop",
    id: "keiko.editor.debugStop",
    keybinding: (keys): number => keys.KeyMod.Shift | keys.KeyCode.F5,
  },
];

export function buildDebugCommandActionDescriptors(args: {
  readonly keys: DebugCommandActionKeys;
  readonly handlers: EditorDebugCommandHandlers;
}): readonly monaco.editor.IActionDescriptor[] {
  return DEBUG_COMMAND_DEFINITIONS.map((definition, index) => ({
    id: definition.id,
    label: args.handlers.labels?.[definition.action] ?? definition.id,
    keybindings: [definition.keybinding(args.keys)],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 10 + index,
    run: (): void => {
      if (args.handlers.isAvailable?.(definition.action) === false) return;
      args.handlers[definition.action]();
    },
  }));
}
