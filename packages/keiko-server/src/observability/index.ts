// One import site for the server activity log. `server-log.ts` owns the sink, the line format and
// rotation; `server-logger.ts` owns the calling surface, the level gate and the bound context;
// `log-redaction.ts` owns the field policy and `log-level.ts` the severity ordering. Instrumentation
// sites should import from here so the layering stays an implementation detail — and so the modules
// never need to import each other in both directions.

import { configureActivityLogRouteRedactor } from "@oscharko-dev/keiko-activity-log";
import { redactRoutePath } from "./route-template.js";

// The route vocabulary stays in the BFF. The package defaults to refusing every path until the
// server composition root supplies this narrow reducer.
configureActivityLogRouteRedactor(redactRoutePath);

export * from "@oscharko-dev/keiko-activity-log";
export { redactRoutePath } from "./route-template.js";
