#include <assert.h>
#include <string.h>

#if defined(_WIN32)

#include <windows.h>

static wchar_t mutation_path[32768];
static int mutation_attempted;
static int mutation_blocked;
static void attempt_mutation_after_pin(const char *name);
#define KEIKO_TREE_WINDOWS_AFTER_FILE_PIN(name) attempt_mutation_after_pin(name)
#define KEIKO_TREE_WINDOWS_PATH_API 1
#include "keiko-portable-tree-hash.h"
#undef KEIKO_TREE_WINDOWS_PATH_API
#undef KEIKO_TREE_WINDOWS_AFTER_FILE_PIN

static void write_fixture(const wchar_t *path, const char *value) {
  DWORD written = 0;
  HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL, NULL);
  assert(file != INVALID_HANDLE_VALUE);
  assert(WriteFile(file, value, (DWORD)strlen(value), &written, NULL) != 0);
  assert(written == (DWORD)strlen(value));
  assert(FlushFileBuffers(file) != 0);
  assert(CloseHandle(file) != 0);
}

static void append_fixture_path(wchar_t *output, size_t cap, const wchar_t *root,
                                const wchar_t *suffix) {
  int written = _snwprintf_s(output, cap, _TRUNCATE, L"%ls%ls", root, suffix);
  assert(written > 0 && (size_t)written < cap);
}

static void attempt_mutation_after_pin(const char *name) {
  HANDLE file;
  if (strcmp(name, "B.txt") != 0) return;
  mutation_attempted = 1;
  file = CreateFileW(mutation_path, GENERIC_WRITE,
                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                     NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  mutation_blocked = file == INVALID_HANDLE_VALUE;
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
}

static void test_allowed_deep_tree(const wchar_t *temp) {
  wchar_t *root = (wchar_t *)calloc(32768u, sizeof(wchar_t));
  wchar_t *current = (wchar_t *)calloc(32768u, sizeof(wchar_t));
  wchar_t *file = (wchar_t *)calloc(32768u, sizeof(wchar_t));
  char digest[65];
  unsigned int depth;
  assert(root != NULL && current != NULL && file != NULL);
  assert(GetTempFileNameW(temp, L"khd", 0, root) != 0);
  assert(DeleteFileW(root) != 0);
  assert(CreateDirectoryW(root, NULL) != 0);
  assert(_snwprintf_s(current, 32768u, _TRUNCATE, L"\\\\?\\%ls", root) > 0);
  for (depth = 0; depth < KEIKO_TREE_MAX_DEPTH; ++depth) {
    size_t length = wcslen(current);
    assert(length < 32765u);
    current[length] = L'\\';
    current[length + 1u] = L'd';
    current[length + 2u] = L'\0';
    assert(CreateDirectoryW(current, NULL) != 0);
  }
  append_fixture_path(file, 32768u, current, L"\\leaf.txt");
  write_fixture(file, "deep\n");
  assert(keiko_tree_hash_windows(root, keiko_tree_now_ms() + 20000u, digest));
  assert(DeleteFileW(file) != 0);
  while (depth > 0) {
    wchar_t *separator;
    assert(RemoveDirectoryW(current) != 0);
    separator = wcsrchr(current, L'\\');
    assert(separator != NULL);
    *separator = L'\0';
    depth -= 1u;
  }
  assert(RemoveDirectoryW(root) != 0);
  free(file);
  free(current);
  free(root);
}

int main(void) {
  static const char expected[] =
    "4d120aeb0383a39dfd0d1782e7cb3e4d0ed6b0e86658842e1b8db2c1efdafca4";
  wchar_t temp[32768], root[32768], nested[32768], file[32768], hardlink[32768];
  char digest[65];
  DWORD temp_length = GetTempPathW(32768, temp);
  HANDLE root_handle;
  keiko_tree_windows_pins pins = {0};
  assert(temp_length > 0 && temp_length < 32768);
  assert(GetTempFileNameW(temp, L"kht", 0, root) != 0);
  assert(DeleteFileW(root) != 0);
  assert(CreateDirectoryW(root, NULL) != 0);
  append_fixture_path(mutation_path, 32768, root, L"\\B.txt");
  write_fixture(mutation_path, "upper");
  append_fixture_path(nested, 32768, root, L"\\z");
  assert(CreateDirectoryW(nested, NULL) != 0);
  append_fixture_path(file, 32768, nested, L"\\a.txt");
  write_fixture(file, "nested");

  root_handle = CreateFileW(root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  assert(root_handle != INVALID_HANDLE_VALUE);
  assert(keiko_tree_hash_windows_handle_pinned(
    root_handle, keiko_tree_now_ms() + 5000u, digest, &pins));
  assert(strcmp(digest, expected) == 0);
  assert(mutation_attempted == 1);
  assert(mutation_blocked == 1);
  assert(CloseHandle(root_handle) != 0);
  keiko_tree_windows_pins_clear(&pins);
  write_fixture(mutation_path, "tampered");
  assert(keiko_tree_hash_windows(root, keiko_tree_now_ms() + 5000u, digest));
  assert(strcmp(digest, expected) != 0);
  write_fixture(mutation_path, "upper");

  append_fixture_path(hardlink, 32768, root, L"\\hardlink.txt");
  assert(CreateHardLinkW(hardlink, file, NULL) != 0);
  assert(!keiko_tree_hash_windows(root, keiko_tree_now_ms() + 5000u, digest));
  assert(DeleteFileW(hardlink) != 0);
  assert(!keiko_tree_hash_windows(root, keiko_tree_now_ms() - 1u, digest));

  assert(DeleteFileW(file) != 0);
  assert(RemoveDirectoryW(nested) != 0);
  assert(DeleteFileW(mutation_path) != 0);
  assert(RemoveDirectoryW(root) != 0);
  test_allowed_deep_tree(temp);
  return 0;
}

#else

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

#include "keiko-portable-tree-hash.h"

static void write_fixture(const char *path, const char *value) {
  int descriptor = open(path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0600);
  assert(descriptor != -1);
  assert(write(descriptor, value, strlen(value)) == (ssize_t)strlen(value));
  assert(close(descriptor) == 0);
}

int main(void) {
  char root[] = "/tmp/keiko-tree-hash.XXXXXX";
  char path[256], digest[65];
  keiko_tree_walk_budget exhausted_entries = {KEIKO_TREE_MAX_ENTRIES, 0};
  keiko_tree_walk_budget exhausted_paths = {0, KEIKO_TREE_MAX_PATH_BYTES};
  assert(!keiko_tree_record_entry(&exhausted_entries, "x"));
  assert(!keiko_tree_record_entry(&exhausted_paths, "x"));
  assert(mkdtemp(root) != NULL);
  assert(snprintf(path, sizeof(path), "%s/alpha", root) > 0);
  write_fixture(path, "one");
  assert(snprintf(path, sizeof(path), "%s/nested", root) > 0);
  assert(mkdir(path, 0700) == 0);
  assert(snprintf(path, sizeof(path), "%s/nested/beta", root) > 0);
  write_fixture(path, "two");
  assert(keiko_tree_hash_posix(root, keiko_tree_now_ms() + 5000u, digest));
  assert(strcmp(digest, "f536aaa0d630fc87a8317ad69c5588eefce2384b516d6957a4dfd32c853adef8") == 0);
  assert(snprintf(path, sizeof(path), "%s/pipe", root) > 0);
  assert(mkfifo(path, 0600) == 0);
  alarm(2);
  assert(!keiko_tree_hash_posix(root, keiko_tree_now_ms() + 1000u, digest));
  alarm(0);
  assert(unlink(path) == 0);
  assert(snprintf(path, sizeof(path), "%s/nested/beta", root) > 0);
  assert(unlink(path) == 0);
  assert(snprintf(path, sizeof(path), "%s/nested", root) > 0);
  assert(rmdir(path) == 0);
  assert(snprintf(path, sizeof(path), "%s/alpha", root) > 0);
  assert(unlink(path) == 0);
  assert(rmdir(root) == 0);

  {
    char deep[] = "/tmp/keiko-tree-depth.XXXXXX";
    char current[4096];
    unsigned int depth;
    assert(mkdtemp(deep) != NULL);
    assert(snprintf(current, sizeof(current), "%s", deep) > 0);
    for (depth = 0; depth <= KEIKO_TREE_MAX_DEPTH; ++depth) {
      size_t length = strlen(current);
      assert(length + 3 < sizeof(current));
      memcpy(current + length, "/d", 3);
      assert(mkdir(current, 0700) == 0);
    }
    assert(!keiko_tree_hash_posix(deep, keiko_tree_now_ms() + 5000u, digest));
    while (strcmp(current, deep) != 0) {
      char *separator;
      assert(rmdir(current) == 0);
      separator = strrchr(current, '/');
      assert(separator != NULL);
      *separator = '\0';
    }
    assert(rmdir(deep) == 0);
  }
  return 0;
}

#endif
