// Browser and loopback callers naturally provide BCP-47 language hints such as `de-DE`, while
// OpenAI-compatible speech endpoints accept the primary ISO-639 language subtag.
export function providerSpeechLanguage(language: string): string {
  const separator = language.indexOf("-");
  return separator === -1 ? language : language.slice(0, separator);
}
