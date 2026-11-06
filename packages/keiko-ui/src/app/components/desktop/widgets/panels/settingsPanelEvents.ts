export const OPEN_EDITOR_SETTINGS_EVENT = "keiko:settings:open-editor";

/** A readiness refusal opens the existing model verification controls; it never runs a probe. */
export const OPEN_MODEL_SETTINGS_EVENT = "keiko:settings:open-models";

export function requestModelSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_MODEL_SETTINGS_EVENT));
}
