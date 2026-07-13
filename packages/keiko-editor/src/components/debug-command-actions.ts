import type * as monaco from "monaco-editor";

/** The seven bounded debugger controls exposed through Monaco's command palette. */
export type EditorDebugCommandAction =
  "continue" | "pause" | "stepOver" | "stepInto" | "stepOut" | "stop";

export interface EditorDebugCommandHandlers {
  readonly continue: () => void;
  readonly pause: () => void;
  readonly stepOver: () => void;
  readonly stepInto: () => void;
  readonly stepOut: () => void;
  readonly stop: () => void;
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
  readonly label: string;
  readonly keybinding: (keys: DebugCommandActionKeys) => number;
}

const DEBUG_COMMAND_DEFINITIONS: readonly DebugCommandDefinition[] = [
  {
    action: "continue",
    id: "keiko.editor.debugContinue",
    label: "Debug: Continue",
    keybinding: (keys): number => keys.KeyCode.F5,
  },
  {
    action: "pause",
    id: "keiko.editor.debugPause",
    label: "Debug: Pause",
    keybinding: (keys): number => keys.KeyCode.F6,
  },
  {
    action: "stepOver",
    id: "keiko.editor.debugStepOver",
    label: "Debug: Step Over",
    keybinding: (keys): number => keys.KeyCode.F10,
  },
  {
    action: "stepInto",
    id: "keiko.editor.debugStepInto",
    label: "Debug: Step Into",
    keybinding: (keys): number => keys.KeyCode.F11,
  },
  {
    action: "stepOut",
    id: "keiko.editor.debugStepOut",
    label: "Debug: Step Out",
    keybinding: (keys): number => keys.KeyMod.Shift | keys.KeyCode.F11,
  },
  {
    action: "stop",
    id: "keiko.editor.debugStop",
    label: "Debug: Stop",
    keybinding: (keys): number => keys.KeyMod.Shift | keys.KeyCode.F5,
  },
];

export function buildDebugCommandActionDescriptors(args: {
  readonly keys: DebugCommandActionKeys;
  readonly handlers: EditorDebugCommandHandlers;
}): readonly monaco.editor.IActionDescriptor[] {
  return DEBUG_COMMAND_DEFINITIONS.map((definition, index) => ({
    id: definition.id,
    label: definition.label,
    keybindings: [definition.keybinding(args.keys)],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 10 + index,
    run: args.handlers[definition.action],
  }));
}
