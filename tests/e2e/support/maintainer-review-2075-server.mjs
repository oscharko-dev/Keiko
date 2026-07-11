import { createServer } from "node:http";
import { serveMaintainerUi } from "../../../packages/keiko-feedback-intake/dist/maintainer-ui.js";

const port = Number(process.env.KEIKO_E2E_PORT ?? "4215");
const origin = `http://127.0.0.1:${port}`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", origin);
  void serveMaintainerUi(req.method, url.pathname, res).then((served) => {
    if (served) return;
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end('{"error":"not-found"}');
  });
});

server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
