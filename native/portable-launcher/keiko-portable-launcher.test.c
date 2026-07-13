#include <assert.h>
#include <string.h>

#define main keiko_portable_launcher_product_main
#include "keiko-portable-launcher.c"
#undef main

int main(void) {
  char path[64];
  assert(dirname_copy(path, sizeof(path), "/tmp/Keiko.app/Contents/MacOS/keiko") == 1);
  assert(strcmp(path, "/tmp/Keiko.app/Contents/MacOS") == 0);
  assert(dirname_copy(path, sizeof(path), "keiko") == 0);
  assert(dirname_copy(path, 4, "/too/long") == 0);
  assert(join_path(path, sizeof(path), "/tmp/Keiko.app", "/Contents/Resources") == 1);
  assert(strcmp(path, "/tmp/Keiko.app/Contents/Resources") == 0);
  assert(join_path(path, 5, "/tmp", "/Keiko") == 0);
  return 0;
}
