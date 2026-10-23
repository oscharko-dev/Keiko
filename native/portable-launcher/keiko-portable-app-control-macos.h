#ifndef KEIKO_PORTABLE_APP_CONTROL_MACOS_H
#define KEIKO_PORTABLE_APP_CONTROL_MACOS_H

/* Darwin's inherited socket is an app-only capability. Generic tool spawns never inherit FD8.
 * Unlike Linux's SO_PASSCRED transport it does not advertise per-message PID credentials. */
static int keiko_handoff_receive(keiko_runtime_owner *owner) {
  size_t target = owner->app_pending_bytes < 12u ? 12u :
      read_u16(owner->app_pending + 6) == 2 ? 212u : 44u;
  ssize_t count = recv(owner->app_control, owner->app_pending + owner->app_pending_bytes,
                         target - owner->app_pending_bytes, MSG_DONTWAIT);
  if (count < 0 && (errno == EINTR || errno == EAGAIN)) return 1;
  if (count <= 0 || !keiko_owner_root_reference(owner, keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS))
    return 0;
  if (owner->app_pending_bytes == 0)
    owner->app_pending_deadline = keiko_tree_now_ms() + KEIKO_OWNER_BOUND_MS;
  if (!keiko_tree_before_deadline(owner->app_pending_deadline)) return 0;
  owner->app_pending_bytes += (size_t)count;
  if (owner->app_pending_bytes < 12u) return 1;
  const unsigned char *bytes = owner->app_pending;
  uint16_t kind = read_u16(bytes + 6);
  uint32_t length = kind == 2 ? 200u : 32u;
  if (memcmp(bytes, "KHU1", 4) != 0 || read_u16(bytes + 4) != 1 ||
      (kind != 2 && kind != 4 && kind != 6 && kind != 8) || read_u32(bytes + 8) != length ||
      owner->app_pending_bytes > 12u + length) return 0;
  if (owner->app_pending_bytes < 12u + length) return 1;
  int result = keiko_handoff_action(owner, kind, bytes + 12, owner->app_pending_deadline);
  owner->app_pending_bytes = 0;
  return result;
}
#endif
