// The identity of this server process, regenerated at every start (#4370).
//
// A browser that held a session before a restart cannot tell, from the denial alone, why the session
// is gone. Health reports this random value so the page can compare it with the one it saw while it
// was connected and say plainly that Keiko was restarted. It is not a credential: it grants nothing,
// is not derived from any secret, and a different value only proves a different process.

import { randomBytes } from "node:crypto";

export const SERVER_INSTANCE_ID: string = randomBytes(16).toString("hex");
