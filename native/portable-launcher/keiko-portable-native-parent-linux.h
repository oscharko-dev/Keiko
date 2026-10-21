#ifndef KEIKO_PORTABLE_NATIVE_PARENT_LINUX_H
#define KEIKO_PORTABLE_NATIVE_PARENT_LINUX_H

#include "../runtime-supervisor/macos/keiko_runtime_protocol.h"

static int keiko_coordinator_environment_reader(int descriptor, void *buffer, size_t length,
                                                 void *context) {
  (void)descriptor;
  return keiko_coordinator_read_exact_deadline(9, buffer, length, *(const uint64_t *)context);
}

static int keiko_coordinator_native_environment(keiko_coordinator_context *context,
                                                uint64_t deadline) {
  struct stat status;
  int required = F_SEAL_SEAL | F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE;
  int seals = fcntl(9, F_GET_SEALS);
  int result = fstat(9, &status) == 0 && S_ISREG(status.st_mode) &&
      status.st_uid == geteuid() && (status.st_mode & 0777) == 0600 &&
      status.st_size >= 16 && status.st_size <= KRP_MAX_PACKET &&
      seals >= 0 && (seals & required) == required && lseek(9, 0, SEEK_CUR) == 0 &&
      read_app_environment(&context->native_environment, keiko_coordinator_environment_reader, &deadline) &&
      (size_t)status.st_size == 12u + context->native_environment.storage_length - 1u &&
      keiko_tree_before_deadline(deadline);
  if (close(9) != 0) result = 0;
  return result;
}

static int keiko_coordinator_native_deadline(uint64_t *deadline) {
  const char *text = getenv("KEIKO_APP_HANDOFF_DEADLINE_MS");
  if (text == NULL) return 1;
  uint64_t original;
  if (!keiko_positive_u64(text, UINT64_MAX, &original)) return 0;
  if (original < *deadline) *deadline = original;
  return keiko_tree_before_deadline(*deadline);
}

/* This private pipe is inherited from W. EOF is never an old-generation completion proof. */
static int keiko_coordinator_native_envelope(const keiko_coordinator_context *context,
                                             uint16_t kind, uint64_t deadline) {
  unsigned char bytes[148];
  uint64_t root;
  struct stat channel;
  int flags = fcntl(7, F_GETFL);
  if (!keiko_khp_decimal_value(context->plan.field[KEIKO_KHP_OLD_PID], INT32_MAX, &root) ||
      flags < 0 || (flags & O_ACCMODE) != O_RDONLY || fstat(7, &channel) != 0 ||
      !S_ISFIFO(channel.st_mode) || channel.st_uid != geteuid() ||
      !keiko_coordinator_read_exact_deadline(7, bytes, sizeof(bytes), deadline)) return 0;
  return memcmp(bytes, "KHO1", 4) == 0 && read_u16(bytes + 4) == 1 &&
         read_u16(bytes + 6) == kind && read_u32(bytes + 8) == 136 &&
         read_u32(bytes + 12) == (uint32_t)root &&
         read_u32(bytes + 16) == (uint32_t)getppid() &&
         memcmp(bytes + 20, context->plan.field[KEIKO_KHP_OLD_LAUNCH_ID], 32) == 0 &&
         memcmp(bytes + 52, context->plan.field[KEIKO_KHP_ACTIVATION_ID], 32) == 0 &&
         memcmp(bytes + 84, context->plan_sha256, 64) == 0 &&
         keiko_tree_before_deadline(deadline);
}

static int keiko_coordinator_parent_matches(keiko_coordinator_context *context,
                                            uint64_t deadline) {
  uint64_t root;
  if (!keiko_khp_decimal_value(context->plan.field[KEIKO_KHP_OLD_PID], INT32_MAX, &root)) return 0;
  if ((uint64_t)getppid() == root) return 1;
  char content[16u * 1024u];
  struct pollfd held = {6, POLLIN, 0};
  if (getenv("KEIKO_APP_HANDOFF_DEADLINE_MS") == NULL || !keiko_parent_death_is_armed() ||
      !keiko_owner_read_proc("/proc/self/status", content, sizeof(content), deadline) ||
      !keiko_owner_proc_scalar(content, "NSpid:", getpid()) ||
      !keiko_owner_proc_scalar(content, "NStgid:", getpid()) ||
      !keiko_owner_read_proc("/proc/self/fdinfo/6", content, sizeof(content), deadline) ||
      !keiko_owner_proc_scalar(content, "Pid:", (pid_t)root) ||
      poll(&held, 1, 0) != 0 || !keiko_coordinator_native_envelope(context, 1, deadline) ||
      !keiko_coordinator_native_environment(context, deadline) ||
      fcntl(6, F_SETFD, FD_CLOEXEC) != 0 || fcntl(7, F_SETFD, FD_CLOEXEC) != 0) return 0;
  context->native_handoff = 1;
  return 1;
}

#endif
