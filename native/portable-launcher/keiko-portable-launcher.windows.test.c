#include <assert.h>
#include <stdio.h>
#include <wchar.h>

#define KEIKO_PORTABLE_LAUNCHER_TEST 1
#define wmain keiko_portable_launcher_product_main
#include "keiko-portable-launcher.c"
#undef wmain
#undef KEIKO_PORTABLE_LAUNCHER_TEST

#if defined(KEIKO_PORTABLE_GENERATION_ID)

static void make_directory(const wchar_t *path) {
  assert(CreateDirectoryW(path, NULL) != 0);
}

static void write_fixture_file(const wchar_t *path, const char *content) {
  DWORD written = 0;
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_NEW,
                            FILE_ATTRIBUTE_NORMAL, NULL);
  assert(file != INVALID_HANDLE_VALUE);
  assert(WriteFile(file, content, (DWORD)strlen(content), &written, NULL) != 0);
  assert(written == (DWORD)strlen(content));
  assert(FlushFileBuffers(file) != 0);
  assert(CloseHandle(file) != 0);
}

static void fixture_path(wchar_t *out, size_t cap, const wchar_t *root,
                         const wchar_t *suffix) {
  assert(append_path(out, cap, root, suffix) == 1);
}

static void create_generation_fixture(const wchar_t *root) {
  wchar_t path[KEIKO_PATH_CAP];
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\.portable");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\.portable\\generations");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID));
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\.portable");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\app");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\app\\dist");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\app\\dist\\cli");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\runtime");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\runtime\\node");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\.portable\\runtime-activation.json");
  write_fixture_file(path, "activation\n");
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\app\\dist\\cli\\index.js");
  write_fixture_file(path, "cli\n");
  fixture_path(path, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\runtime\\node\\node.exe");
  write_fixture_file(path, "node\n");
}

static void create_legacy_fixture(const wchar_t *root) {
  wchar_t path[KEIKO_PATH_CAP];
  make_directory(root);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\app");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\app\\dist");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\app\\dist\\cli");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\runtime");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\runtime\\node");
  make_directory(path);
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\app\\dist\\cli\\index.js");
  write_fixture_file(path, "flat cli\n");
  fixture_path(path, KEIKO_PATH_CAP, root, L"\\runtime\\node\\node.exe");
  write_fixture_file(path, "flat node\n");
}

static void remove_generation_fixture(const wchar_t *root) {
  wchar_t path[KEIKO_PATH_CAP];
  static const wchar_t *files[] = {
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\.portable\\runtime-activation.json",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\app\\dist\\cli\\index.js",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\runtime\\node\\node.exe",
    L"\\app\\dist\\cli\\index.js",
    L"\\runtime\\node\\node.exe"
  };
  static const wchar_t *directories[] = {
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\runtime\\node",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\runtime",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\app\\dist\\cli",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\app\\dist",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\app",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
      L"\\.portable",
    L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID),
    L"\\.portable\\generations",
    L"\\.portable",
    L"\\runtime\\node",
    L"\\runtime",
    L"\\app\\dist\\cli",
    L"\\app\\dist",
    L"\\app"
  };
  size_t index;
  for (index = 0; index < sizeof(files) / sizeof(files[0]); ++index) {
    fixture_path(path, KEIKO_PATH_CAP, root, files[index]);
    assert(DeleteFileW(path) != 0);
  }
  for (index = 0; index < sizeof(directories) / sizeof(directories[0]); ++index) {
    fixture_path(path, KEIKO_PATH_CAP, root, directories[index]);
    assert(RemoveDirectoryW(path) != 0);
  }
  assert(RemoveDirectoryW(root) != 0);
}

static void test_generation_selection(void) {
  wchar_t temp[KEIKO_PATH_CAP], root[KEIKO_PATH_CAP], expected[KEIKO_PATH_CAP];
  wchar_t wrong[KEIKO_PATH_CAP], link_target[KEIKO_PATH_CAP];
  DWORD length = GetTempPathW(KEIKO_PATH_CAP, temp);
  keiko_generation_pins pins;
  keiko_launcher_buffers *buffers = allocate_launcher_buffers();
  assert(length > 0 && length < KEIKO_PATH_CAP);
  assert(buffers != NULL);
  assert(GetTempFileNameW(temp, L"kgl", 0, root) != 0);
  assert(DeleteFileW(root) != 0);
  create_legacy_fixture(root);
  wcscpy_s(buffers->root, KEIKO_PATH_CAP, root);
  assert(select_generation_resources(buffers, &pins) == 0);
  create_generation_fixture(root);
  fixture_path(link_target, KEIKO_PATH_CAP, root, L"-root-link");
  assert(CreateSymbolicLinkW(link_target, root,
                             SYMBOLIC_LINK_FLAG_DIRECTORY |
                               SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE) != 0);
  wcscpy_s(buffers->root, KEIKO_PATH_CAP, link_target);
  assert(select_generation_resources(buffers, &pins) == 0);
  assert(DeleteFileW(link_target) != 0);
  wcscpy_s(buffers->root, KEIKO_PATH_CAP, root);
  fixture_path(expected, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID));
  fixture_path(wrong, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\0000000000000000000000000000000000000000000000000000000000000000");
  assert(MoveFileExW(expected, wrong, MOVEFILE_WRITE_THROUGH) != 0);
  assert(select_generation_resources(buffers, &pins) == 0);
  assert(MoveFileExW(wrong, expected, MOVEFILE_WRITE_THROUGH) != 0);
  assert(SetEnvironmentVariableW(L"KEIKO_PORTABLE_GENERATION_ID", L"wrong") != 0);
  assert(SetEnvironmentVariableW(L"PATH", L"C:\\untrusted") != 0);
  assert(select_generation_resources(buffers, &pins) == 1);
  fixture_path(expected, KEIKO_PATH_CAP, buffers->root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\runtime\\node\\node.exe");
  assert(wcscmp(buffers->node, expected) == 0);
  fixture_path(expected, KEIKO_PATH_CAP, buffers->root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\app\\dist\\cli\\index.js");
  assert(wcscmp(buffers->cli, expected) == 0);
  assert(DeleteFileW(expected) == 0);
  fixture_path(expected, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID));
  assert(MoveFileExW(expected, wrong, MOVEFILE_WRITE_THROUGH) == 0);
  fixture_path(expected, KEIKO_PATH_CAP, root, L"-redirected");
  assert(MoveFileExW(root, expected, MOVEFILE_WRITE_THROUGH) == 0);
  close_generation_pins(&pins);

  fixture_path(expected, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\app\\dist\\cli\\index.js");
  assert(DeleteFileW(expected) != 0);
  write_fixture_file(expected, "tampered\n");
  assert(select_generation_resources(buffers, &pins) == 0);
  assert(DeleteFileW(expected) != 0);
  write_fixture_file(expected, "cli\n");

  fixture_path(expected, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\.portable\\runtime-activation.json");
  fixture_path(link_target, KEIKO_PATH_CAP, root,
               L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
               L"\\.portable\\runtime-activation.real");
  assert(MoveFileExW(expected, link_target, MOVEFILE_WRITE_THROUGH) != 0);
  assert(CreateSymbolicLinkW(expected, link_target, SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE) != 0);
  assert(select_generation_resources(buffers, &pins) == 0);
  assert(DeleteFileW(expected) != 0);
  assert(MoveFileExW(link_target, expected, MOVEFILE_WRITE_THROUGH) != 0);

  fixture_path(expected, KEIKO_PATH_CAP, root, L"\\hardlink.js");
  {
    wchar_t source[KEIKO_PATH_CAP];
    fixture_path(source, KEIKO_PATH_CAP, root,
                 L"\\.portable\\generations\\" KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)
                 L"\\app\\dist\\cli\\index.js");
    assert(CreateHardLinkW(expected, source, NULL) != 0);
    assert(select_generation_resources(buffers, &pins) == 0);
  }
  assert(DeleteFileW(expected) != 0);
  remove_generation_fixture(root);
  free_launcher_buffers(buffers);
}

#endif

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

#if defined(KEIKO_PORTABLE_GENERATION_ID)
  assert(generation_id_valid(KEIKO_WIDEN(KEIKO_PORTABLE_GENERATION_ID)) == 1);
  assert(generation_id_valid(L"") == 0);
  assert(generation_id_valid(L"6C88e790a0339797e4941fec266c2f861e7515fb667739e297b8c42c622e6eaa") == 0);
  test_generation_selection();
#else
  {
    keiko_launcher_buffers *legacy = allocate_launcher_buffers();
    assert(legacy != NULL);
    wcscpy_s(legacy->root, KEIKO_PATH_CAP, L"C:\\Keiko");
    assert(select_legacy_resources(legacy) == 1);
    assert(wcscmp(legacy->node, L"C:\\Keiko\\runtime\\node\\node.exe") == 0);
    assert(wcscmp(legacy->cli, L"C:\\Keiko\\app\\dist\\cli\\index.js") == 0);
    free_launcher_buffers(legacy);
  }
#endif

  /* The bootstrap pre-flight must read a present regular file as usable, and both a missing
   * path and a directory wearing the artifact's name as unusable — this is what gates the
   * incomplete-install dialog before any Node spawn. Fixture paths derive from the host's
   * actual system directory instead of assuming the C:\Windows install drive. */
  wchar_t system_dir[MAX_PATH];
  assert(GetSystemDirectoryW(system_dir, MAX_PATH) > 0);
  wchar_t fixture[MAX_PATH + 64];
  assert(_snwprintf_s(fixture, MAX_PATH + 64, _TRUNCATE, L"%ls\\kernel32.dll", system_dir) > 0);
  assert(bootstrap_artifact_unusable(fixture) == 0);
  assert(bootstrap_artifact_unusable(system_dir) == 1);
  assert(
    _snwprintf_s(
      fixture, MAX_PATH + 64, _TRUNCATE, L"%ls\\keiko-missing-bootstrap-probe.exe", system_dir
    ) > 0
  );
  assert(bootstrap_artifact_unusable(fixture) == 1);
  return 0;
}
