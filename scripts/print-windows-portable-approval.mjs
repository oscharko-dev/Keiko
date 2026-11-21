// Prints the Windows native-helper approval the built server enforces, as JSON. The portable stage
// runs it after it has built the packages, to refuse a Windows payload whose helpers the server
// would not start (#4068). Needs `npm run build:packages`.
import { WINDOWS_PORTABLE_RUNTIME_APPROVAL } from "../packages/keiko-server/dist/coding-runtime/npmLaneRuntimeApprovals.js";

process.stdout.write(`${JSON.stringify(WINDOWS_PORTABLE_RUNTIME_APPROVAL)}\n`);
