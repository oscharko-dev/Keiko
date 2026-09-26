#ifndef KEIKO_RUNTIME_MONITOR_PROTOCOL_H
#define KEIKO_RUNTIME_MONITOR_PROTOCOL_H

#include <stdint.h>
#include <stddef.h>
#include <unistd.h>

// KEIKO-0967: read_exact and write_exact were duplicated verbatim across
// keiko_runtime_monitor.m and keiko_system_extension_manager.m. Both files already include this
// header; keeping one definition here removes the drift class. `static inline` is the standard
// C shape for header-hosted helpers that must not create multiple external symbols.
static inline int keiko_read_exact(int descriptor, void *buffer, size_t length) {
  unsigned char *bytes = (unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = read(descriptor, bytes + offset, length - offset);
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

static inline int keiko_write_exact(int descriptor, const void *buffer, size_t length) {
  const unsigned char *bytes = (const unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = write(descriptor, bytes + offset, length - offset);
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

// Legacy aliases: the two files historically named the helpers `read_exact` / `write_exact`.
// Keep the names available so unrelated call sites do not have to move in the same change.
#define read_exact keiko_read_exact
#define write_exact keiko_write_exact

#define KEIKO_MONITOR_SOCKET "/var/run/com.oscharko.keiko.runtime-monitor.sock"
#define KEIKO_MONITOR_VERSION 1u
#define KEIKO_RECOVERY_HANDLE_BYTES 32u

enum keiko_monitor_command {
  KEIKO_MONITOR_PING = 1,
  KEIKO_MONITOR_ARM = 2,
  KEIKO_MONITOR_STOP = 3,
  KEIKO_MONITOR_RECONCILE = 4
};

enum keiko_monitor_response {
  KEIKO_MONITOR_ACTIVE = 1,
  KEIKO_MONITOR_ARMED = 2,
  KEIKO_MONITOR_ROOT_OBSERVED = 3,
  KEIKO_MONITOR_ZERO_LIVE = 4,
  KEIKO_MONITOR_ERROR = 5,
  KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS = 6,
  KEIKO_MONITOR_STARTING = 7,
  KEIKO_MONITOR_FAILED = 8,
  // Compatibility, deliberately without a KEIKO_MONITOR_VERSION bump (review finding on #3159):
  // an older supervisor paired with a newer daemon receives 9 on one narrow path and does not
  // recognise it. Its reconcile() already routes every unrecognised reply into ERROR_TREE_OBSERVE,
  // so it fails closed and reports an observation error instead of misreading the tree as reaped.
  // Bumping the version instead would make the daemon reject EVERY v1 supervisor outright — a hard
  // break for the mixed-install case, to avoid a soft, fail-closed degradation in it.
  //
  // KEIKO-0433: RECONCILE against a handle that IS known but already owned by a live connection
  // used to answer KEIKO_MONITOR_ZERO_LIVE — the same code as "no such session". Those demand
  // opposite responses: one means the tree is already supervised and the caller should back off,
  // the other means nothing is left to adopt. Appended, never renumbered: the wire protocol is
  // shared with already-built binaries, so reassigning an existing value would be breaking.
  KEIKO_MONITOR_ALREADY_ACTIVE = 9
};

struct keiko_monitor_request {
  unsigned char magic[4];
  uint16_t version;
  uint16_t command;
  char recovery_handle[KEIKO_RECOVERY_HANDLE_BYTES];
  uint32_t supervisor_pid;
};

struct keiko_monitor_reply {
  unsigned char magic[4];
  uint16_t version;
  uint16_t kind;
  uint32_t live_processes;
};

#endif
