/* Pipe-relayed confinement without an installed broker (#4068, ADR-0043 D20).
 *
 * The supervised tree runs in an AppContainer that holds NO network capability, so Windows itself
 * refuses every connection out of it: loopback to the host as well as the internet. A standard user
 * can create such a container; nothing here needs elevation, a service or a filter.
 *
 * The tree reaches exactly the loopback port its launch names through named pipes:
 *   host side (this supervisor, unconfined): one pipe per route, its DACL granting only the
 *   container's SID beside the owner and SYSTEM, with a low mandatory label so the container's
 *   token may write. A connected instance is accepted only from a process of this run's container
 *   and is bridged to 127.0.0.1:<host port>.
 *   container side (this image again, as the tree's root, --container-relay): listens on
 *   127.0.0.1:<inner port> inside the container, which an AppContainer may do for itself, rewrites
 *   every "127.0.0.1:<host port>" in the runtime's environment to that inner port, and bridges each
 *   accepted connection to its route's pipe. It then starts the runtime as its child, which
 *   inherits the container and the job.
 * The inbound route serves the host's connection to the runtime's own server: the supervisor
 * listens on 127.0.0.1:<host port>, the relay rewrites the runtime's "listening on
 * http://127.0.0.1:<port>" line to that port and keeps idle pipe instances open; on the open signal
 * an instance connects to the runtime's port inside the container.
 *
 * End of stream travels as a zero-length message, so a half-closed socket stays half-closed. */
#ifndef KEIKO_GATEWAY_RELAY_H
#define KEIKO_GATEWAY_RELAY_H
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

#define KEIKO_RELAY_MAX_ROUTES 4u
#define KEIKO_RELAY_PREFIX_CHARS 32u
#define KEIKO_RELAY_PLAN_CHARS 96u

enum keiko_relay_direction { KEIKO_RELAY_OUTBOUND = 1, KEIKO_RELAY_INBOUND = 2 };

struct keiko_relay_route {
  enum keiko_relay_direction direction;
  USHORT host_port;
};

struct keiko_relay_plan {
  /* 32 lowercase hex characters, the run's recovery handle: names this run's pipes. */
  char prefix[KEIKO_RELAY_PREFIX_CHARS + 1];
  DWORD route_count;
  struct keiko_relay_route routes[KEIKO_RELAY_MAX_ROUTES];
};

/* The relay's argument "<prefix>/<o|i><port>,...". Parsing refuses anything but that grammar, a
 * duplicate port, port 0, more than one inbound route and more than KEIKO_RELAY_MAX_ROUTES. */
int keiko_relay_plan_format(const struct keiko_relay_plan *plan, wchar_t *output, size_t capacity);
int keiko_relay_plan_parse(const wchar_t *text, struct keiko_relay_plan *plan);

/* The pipe name of route index i: \\.\pipe\KeikoRelay-<prefix>-<i>. */
void keiko_relay_pipe_name(const struct keiko_relay_plan *plan, DWORD index, wchar_t name[96]);

/* Rewrites every "127.0.0.1:<from>" not followed by a digit in value to "127.0.0.1:<to>".
 * Returns a new string the caller frees, or NULL when memory ran out. */
wchar_t *keiko_relay_rewrite_port(const wchar_t *value, USHORT from, USHORT to);

/* Host side. Binds the inbound route's listener first (port 0 picks a free port, written back into
 * the plan), creates every route's pipe instances for the container SID and serves them in
 * background threads. Returns 0 when anything could not be created. */
int keiko_relay_host_start(struct keiko_relay_plan *plan, PSID container);
void keiko_relay_host_stop(void);

/* Container side: argv is "<image> --container-relay <plan> <executable> [arguments...]". Returns
 * the runtime's exit code, or 126 when the relay could not start it. */
int keiko_relay_container_main(int argc, wchar_t **argv);

#endif
