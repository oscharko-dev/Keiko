// One import site for the server activity log. `server-log.ts` owns the sink, the line format and
// rotation; `server-logger.ts` owns the calling surface, the level gate and the bound context;
// `log-redaction.ts` owns the field policy and `log-level.ts` the severity ordering. Instrumentation
// sites should import from here so the layering stays an implementation detail — and so the modules
// never need to import each other in both directions.

// `server-log.js` already re-exports the level and redaction surfaces, so this barrel stays two
// lines and no name is exported twice.
export * from "./server-log.js";
export * from "./server-logger.js";
