// Counts this project's checks: every `npm test` appends one line before the tests run. The
// acceptance tester compares the count with the checks the run reported, so it does not have to
// trust what the run says about itself (#4492). The file is ignored by Git.
import { appendFileSync } from "node:fs";

appendFileSync(new URL("../.acceptance-checks", import.meta.url), "check\n");
