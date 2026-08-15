#ifndef KEIKO_RUNTIME_MONITOR_PROTOCOL_H
#define KEIKO_RUNTIME_MONITOR_PROTOCOL_H

#include <stdint.h>

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
