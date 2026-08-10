#include <assert.h>
#include <wchar.h>

#define wmain keiko_portable_launcher_product_main
#include "keiko-portable-launcher.c"
#undef wmain

int wmain(void) {
  keiko_launcher_buffers *buffers = allocate_launcher_buffers();
  assert(buffers != NULL);
  assert(sizeof(buffers->root) / sizeof(buffers->root[0]) == (size_t)KEIKO_PATH_CAP);
  assert(sizeof(buffers->command) / sizeof(buffers->command[0]) == (size_t)KEIKO_COMMAND_CAP);
  free_launcher_buffers(buffers);

  wchar_t path[64] = L"C:\\Keiko\\runtime\\node.exe";
  assert(dirname_in_place(path) == 1);
  assert(wcscmp(path, L"C:\\Keiko\\runtime") == 0);
  assert(dirname_in_place(path) == 1);
  assert(wcscmp(path, L"C:\\Keiko") == 0);

  wchar_t joined[64];
  assert(append_path(joined, 64, L"C:\\Keiko", L"\\app\\dist\\cli\\index.js") == 1);
  assert(wcscmp(joined, L"C:\\Keiko\\app\\dist\\cli\\index.js") == 0);
  assert(append_path(joined, 4, L"C:\\Keiko", L"\\runtime") == 0);

  wchar_t quoted[32];
  assert(quote_arg(quoted, 32, L"C:\\Keiko") == 1);
  assert(wcscmp(quoted, L"\"C:\\Keiko\"") == 0);
  assert(quote_arg(quoted, 4, L"C:\\Keiko") == 0);

  assert(creation_flags_for_console_state(1) == 0);
  assert(creation_flags_for_console_state(0) == CREATE_NO_WINDOW);
  return 0;
}
