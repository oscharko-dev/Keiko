// One lab lane for the two-process work-lock regression. The parent test passes a JSON config as
// argv[2] and steers the lane through marker files in `markers`; nothing here touches Jira.
//
// A lane can pause at named points of the lock protocol. The pause hooks wrap the real `node:fs`
// calls the lock module makes (so the lock implementation is not altered): "ticket" stops just
// before the lane publishes its queue ticket, "commit" stops just before the lane changes the lock
// itself (removing a stale lock, or publishing its generation) after it has inspected the owner.
import fs, { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const config = JSON.parse(process.argv[2]);
const { name, directory, markers, role = "lane", pauses = [] } = config;
const mark = (file) => writeFileSync(join(markers, file), "");
const marked = (file) => existsSync(join(markers, file));
const record = (event) => appendFileSync(join(markers, "events.log"), `${event}\n`);

function pauseOnce(point) {
  mark(`${name}-paused-${point}`);
  while (!marked(`go-${name}-${point}`))
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  mark(`${name}-resumed-${point}`);
}

function hook(method, point, matches) {
  const original = fs[method];
  let pending = pauses.includes(point);
  fs[method] = (...args) => {
    if (pending && matches(String(args[0]), String(args[1]))) {
      pending = false;
      pauseOnce(point);
    }
    return original(...args);
  };
}

hook("writeFileSync", "ticket", (path) => path.includes("work-project.queue"));
hook("rmSync", "commit", (path) => path.endsWith("work-project.lock"));
hook("renameSync", "commit", (_from, to) => to.includes("work-project.lock."));
syncBuiltinESMExports();

const { withWorkProjectLock } =
  await import("../../../testing/jira-chat-lab/requirements/work-project-lock.mjs");

async function journey() {
  record(`${name}-enter`);
  if (role === "crash") process.kill(process.pid, "SIGKILL");
  writeFileSync(join(markers, "req-1"), name);
  mark(`${name}-inside`);
  while (!marked(`release-${name}`)) await delay(5); // NOSONAR typescript:S9382 -- waits for the parent's marker
  record(`${name}-exit`);
}

await withWorkProjectLock(directory, "S05", journey, {
  pollMs: 10,
  onWait: () => mark(`${name}-polled`),
  // The reset the runner performs once it holds the lock: it empties the work project.
  prepare: () => {
    record(`${name}-prepare`);
    rmSync(join(markers, "req-1"), { force: true });
    return Promise.resolve();
  },
});
