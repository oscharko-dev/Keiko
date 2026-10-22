#ifndef KEIKO_PORTABLE_NATIVE_ENVELOPE_POSIX_H
#define KEIKO_PORTABLE_NATIVE_ENVELOPE_POSIX_H

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


static int keiko_coordinator_native_deadline(uint64_t *deadline) {
  const char *text = getenv("KEIKO_APP_HANDOFF_DEADLINE_MS");
  if (text == NULL) return 1;
  uint64_t original;
  if (!keiko_positive_u64(text, UINT64_MAX, &original)) return 0;
  if (original < *deadline) *deadline = original;
  return keiko_tree_before_deadline(*deadline);
}


#endif
