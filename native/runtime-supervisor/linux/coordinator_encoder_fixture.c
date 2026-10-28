/* Exercise the actual POSIX coordinator encoder, without executing its launcher or cutover. */
#define _GNU_SOURCE
#define main keiko_portable_launcher_product_main
#include "../../portable-launcher/keiko-portable-launcher.c"
#undef main

int main(int argc, char **argv) {
  if (argc != 5) return 2;
  keiko_coordinator_context context;
  memset(&context, 0, sizeof(context));
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = argv[4];
  context.plan.field[KEIKO_KHP_MANAGED_ROOT] = argv[2];
  int length = snprintf(context.state_dir, sizeof(context.state_dir), "%s", argv[3]);
  if (length <= 0 || (size_t)length >= sizeof(context.state_dir)) return 3;
  unsigned char *packet = NULL;
  size_t size = 0;
  if (!keiko_coordinator_launch_packet(&context, argv[1], 0, &packet, &size)) return 4;
  int success = keiko_coordinator_write_exact(STDOUT_FILENO, packet, size);
  free(packet);
  return success ? 0 : 5;
}
