#ifndef KEIKO_PORTABLE_GENERATION_WINDOWS_H
#define KEIKO_PORTABLE_GENERATION_WINDOWS_H

enum { KEIKO_GENERATION_PIN_CAP = 10, KEIKO_GENERATION_HASH_TIMEOUT_MS = 15 * 60 * 1000 };

typedef struct {
  HANDLE handle[KEIKO_GENERATION_PIN_CAP];
  size_t count;
  keiko_tree_windows_pins tree;
} keiko_generation_pins;

static int generation_id_valid(const wchar_t *value) {
  size_t index;
  for (index = 0; index < 64u; ++index) {
    wchar_t character = value[index];
    if (character == L'\0' ||
        !((character >= L'0' && character <= L'9') ||
          (character >= L'a' && character <= L'f'))) return 0;
  }
  return value[64] == L'\0';
}

static void close_generation_pins(keiko_generation_pins *pins) {
  while (pins->count > 0) CloseHandle(pins->handle[--pins->count]);
  keiko_tree_windows_pins_clear(&pins->tree);
}

static HANDLE pin_generation_child(keiko_generation_pins *pins, HANDLE parent,
                                   const wchar_t *name, int directory) {
  HANDLE child;
  if (pins->count >= KEIKO_GENERATION_PIN_CAP) return INVALID_HANDLE_VALUE;
  child = keiko_tree_windows_open_child(parent, name, directory);
  if (child != INVALID_HANDLE_VALUE) pins->handle[pins->count++] = child;
  return child;
}

static int verify_generation_file(HANDLE parent, const wchar_t *name) {
  HANDLE file = keiko_tree_windows_open_child(parent, name, 0);
  if (file == INVALID_HANDLE_VALUE) return 0;
  CloseHandle(file);
  return 1;
}

static int generation_digest_matches(const wchar_t *generation_id, const char digest[65]) {
  size_t index;
  for (index = 0; index < 64u; ++index)
    if ((wchar_t)(unsigned char)digest[index] != generation_id[index]) return 0;
  return digest[64] == '\0';
}

static int append_generation_path(wchar_t *output, size_t cap, const wchar_t *root,
                                  const wchar_t *generation_id, const wchar_t *suffix) {
  int written = _snwprintf_s(output, cap, _TRUNCATE,
                             L"%ls\\.portable\\generations\\%ls%ls",
                             root, generation_id, suffix);
  return written > 0 && (size_t)written < cap;
}

static int pin_generation_resource_directories(keiko_generation_pins *pins, HANDLE generation,
                                                HANDLE *cli_directory,
                                                HANDLE *node_directory,
                                                HANDLE *activation_directory) {
  HANDLE app = pin_generation_child(pins, generation, L"app", 1);
  HANDLE dist = pin_generation_child(pins, app, L"dist", 1);
  HANDLE runtime = pin_generation_child(pins, generation, L"runtime", 1);
  *cli_directory = pin_generation_child(pins, dist, L"cli", 1);
  *node_directory = pin_generation_child(pins, runtime, L"node", 1);
  *activation_directory = pin_generation_child(pins, generation, L".portable", 1);
  return app != INVALID_HANDLE_VALUE && dist != INVALID_HANDLE_VALUE &&
         runtime != INVALID_HANDLE_VALUE && *cli_directory != INVALID_HANDLE_VALUE &&
         *node_directory != INVALID_HANDLE_VALUE && *activation_directory != INVALID_HANDLE_VALUE;
}

static HANDLE pin_generation_root(keiko_launcher_buffers *buffers, keiko_generation_pins *pins,
                                  const wchar_t *generation_id) {
  HANDLE root = CreateFileW(buffers->root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  HANDLE portable, generations;
  keiko_tree_windows_identity identity;
  if (root == INVALID_HANDLE_VALUE) return INVALID_HANDLE_VALUE;
  if (!keiko_tree_windows_read_identity(root, 1, &identity) ||
      pins->count >= KEIKO_GENERATION_PIN_CAP) {
    CloseHandle(root);
    return INVALID_HANDLE_VALUE;
  }
  pins->handle[pins->count++] = root;
  if (!keiko_tree_windows_final_path(root, buffers->root)) return INVALID_HANDLE_VALUE;
  portable = pin_generation_child(pins, root, L".portable", 1);
  generations = pin_generation_child(pins, portable, L"generations", 1);
  return pin_generation_child(pins, generations, generation_id, 1);
}

static int select_generation_resources(keiko_launcher_buffers *buffers,
                                       keiko_generation_pins *pins) {
  const wchar_t *generation_id = KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID);
  HANDLE generation, cli_directory, node_directory, activation_directory;
  char digest[65];
  uint64_t now = keiko_tree_now_ms(), deadline;
  memset(pins, 0, sizeof(*pins));
  if (!generation_id_valid(generation_id) ||
      now > UINT64_MAX - KEIKO_GENERATION_HASH_TIMEOUT_MS) return 0;
  deadline = now + KEIKO_GENERATION_HASH_TIMEOUT_MS;
  generation = pin_generation_root(buffers, pins, generation_id);
  if (generation == INVALID_HANDLE_VALUE ||
      !keiko_tree_hash_windows_handle_pinned(generation, deadline, digest, &pins->tree) ||
      !generation_digest_matches(generation_id, digest) ||
      !pin_generation_resource_directories(pins, generation, &cli_directory, &node_directory,
                                           &activation_directory) ||
      !verify_generation_file(cli_directory, L"index.js") ||
      !verify_generation_file(node_directory, L"node.exe") ||
      !verify_generation_file(activation_directory, L"runtime-activation.json") ||
      !append_generation_path(buffers->node, KEIKO_PATH_CAP, buffers->root,
                              generation_id, L"\\runtime\\node\\node.exe") ||
      !append_generation_path(buffers->cli, KEIKO_PATH_CAP, buffers->root,
                              generation_id, L"\\app\\dist\\cli\\index.js")) {
    close_generation_pins(pins);
    return 0;
  }
  return 1;
}

#endif
