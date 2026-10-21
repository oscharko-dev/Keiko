/* The persistent app control belongs to the actual root, separately from its metadata port. */
#define _GNU_SOURCE
#include "../macos/keiko_runtime_protocol.h"
#include <assert.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <fcntl.h>

static void qualify_app_control(pid_t root, pid_t owner);
#define KEIKO_APP_CONTROL_QUALIFICATION(root, owner) qualify_app_control(root, owner)
#include "process_scope_root_fixture.c"

static void qualify_app_control(pid_t root, pid_t owner) {
  unsigned char bytes[52];
  int kind;
  socklen_t length = sizeof(kind);
  assert(getsockopt(8, SOL_SOCKET, SO_TYPE, &kind, &length) == 0 && kind == SOCK_STREAM);
  assert(read_exact(8, bytes, sizeof(bytes)));
  assert(memcmp(bytes, "KHU1", 4) == 0 && read_u16(bytes + 4) == 1);
  assert(read_u16(bytes + 6) == 1 && read_u32(bytes + 8) == 40);
  assert(read_u32(bytes + 12) == (uint32_t)root && read_u32(bytes + 16) == (uint32_t)owner);
  assert(getenv("KEIKO_UI_LAUNCH_ID") != NULL);
  assert(memcmp(bytes + 20, getenv("KEIKO_UI_LAUNCH_ID"), 32) == 0);
}
