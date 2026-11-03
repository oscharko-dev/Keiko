#ifndef KEIKO_PORTABLE_NATIVE_PARENT_MACOS_H
#define KEIKO_PORTABLE_NATIVE_PARENT_MACOS_H
#include <libproc.h>

static int keiko_coordinator_parent_matches(keiko_coordinator_context *context,
                                            uint64_t deadline) {
  char parent[PROC_PIDPATHINFO_MAXSIZE];
  pid_t owner = getppid();
  /* The private proof producer must be the admitted launcher owner, outside the old app tree. */
  if (owner <= 1 || getenv("KEIKO_APP_HANDOFF_DEADLINE_MS") == NULL ||
      proc_pidpath(owner, parent, sizeof(parent)) <= 0 ||
      !keiko_coordinator_file_digest_matches(parent,
          context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256], deadline) ||
      !keiko_coordinator_native_envelope(context, 1, deadline) ||
      getppid() != owner || fcntl(7, F_SETFD, FD_CLOEXEC) != 0) return 0;
  context->native_handoff = 1;
  return 1;
}
#endif
