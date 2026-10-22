// Next 16.3.8 awaits this optional diagnostic before starting its Webpack compiler. An unavailable
// registry must settle as the framework's existing "unknown" result within the startup budget.
export const NEXT_VERSION_METADATA_URL = "https://registry.npmjs.org/-/package/next/dist-tags";
export const NEXT_VERSION_METADATA_TIMEOUT_MS = 5_000;

function requestUrl(input) {
  if (typeof input === "string") return input;
  return input instanceof globalThis.URL ? input.href : input?.url;
}

function requestSignal(input, init) {
  if (init?.signal === null) return undefined;
  return init?.signal ?? (input instanceof globalThis.Request ? input.signal : undefined);
}

export function createNextVersionFetch(fetchImpl, reportTimeout) {
  return (input, init) => {
    if (requestUrl(input) !== NEXT_VERSION_METADATA_URL) return fetchImpl(input, init);
    const timeout = globalThis.AbortSignal.timeout(NEXT_VERSION_METADATA_TIMEOUT_MS);
    const inherited = requestSignal(input, init);
    const signal =
      inherited === undefined ? timeout : globalThis.AbortSignal.any([inherited, timeout]);
    return fetchImpl(input, { ...init, signal }).catch((error) => {
      if (timeout.aborted && inherited?.aborted !== true) reportTimeout();
      throw error;
    });
  };
}
