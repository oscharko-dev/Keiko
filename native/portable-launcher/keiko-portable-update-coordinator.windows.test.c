#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include <windows.h>

#ifndef KEIKO_PORTABLE_TARGET
#define KEIKO_PORTABLE_TARGET "windows-x64"
#endif

#include "keiko-portable-update-coordinator.h"
#include "keiko-portable-recovery-control.h"

enum { TEST_PATH_CAP = 32768 };

static int test_join(
    wchar_t output[TEST_PATH_CAP],
    const wchar_t *base,
    const wchar_t *suffix
) {
  int written = _snwprintf_s(output, TEST_PATH_CAP, _TRUNCATE, L"%ls%ls", base, suffix);
  return written > 0 && written < TEST_PATH_CAP;
}

static void test_write(const wchar_t *path, const char *content) {
  HANDLE file = CreateFileW(
      path,
      GENERIC_READ | GENERIC_WRITE,
      0,
      NULL,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
      NULL
  );
  DWORD length = (DWORD)strlen(content);
  DWORD written = 0;
  assert(file != INVALID_HANDLE_VALUE);
  assert(WriteFile(file, content, length, &written, NULL));
  assert(written == length);
  assert(FlushFileBuffers(file));
  assert(CloseHandle(file));
}

static void test_write_sized(const wchar_t *path, uint64_t size) {
  HANDLE file = CreateFileW(
      path,
      GENERIC_READ | GENERIC_WRITE,
      0,
      NULL,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
      NULL
  );
  LARGE_INTEGER end;
  end.QuadPart = (LONGLONG)size;
  assert(file != INVALID_HANDLE_VALUE);
  assert(SetFilePointerEx(file, end, NULL, FILE_BEGIN));
  assert(SetEndOfFile(file));
  assert(FlushFileBuffers(file));
  assert(CloseHandle(file));
}

static void test_tree_hash(const wchar_t *path, char output[65]) {
  HANDLE root = keiko_windows_atomic_open_directory(
      path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ
  );
  keiko_tree_windows_pins pins = {0};
  assert(root != INVALID_HANDLE_VALUE);
  assert(keiko_tree_hash_windows_handle_pinned(
      root,
      GetTickCount64() + 120000u,
      output,
      &pins
  ));
  keiko_tree_windows_pins_clear(&pins);
  assert(CloseHandle(root));
}

static void test_create_root(wchar_t root[TEST_PATH_CAP]) {
  wchar_t temporary[TEST_PATH_CAP];
  DWORD length = GetTempPathW(TEST_PATH_CAP, temporary);
  assert(length > 0 && length < TEST_PATH_CAP);
  assert(GetTempFileNameW(temporary, L"kwc", 0, root) != 0);
  assert(DeleteFileW(root));
  assert(CreateDirectoryW(root, NULL));
}

static void test_copy_walk_budget_is_bounded(void) {
  wchar_t root[TEST_PATH_CAP];
  wchar_t source_path[TEST_PATH_CAP];
  wchar_t destination_path[TEST_PATH_CAP];
  wchar_t source_file_path[TEST_PATH_CAP];
  wchar_t destination_file_path[TEST_PATH_CAP];
  HANDLE source;
  HANDLE destination;
  HANDLE source_file;
  keiko_tree_walk_budget budget;
  uint64_t total_bytes;
  test_create_root(root);
  assert(test_join(source_path, root, L"\\source"));
  assert(test_join(destination_path, root, L"\\destination"));
  assert(CreateDirectoryW(source_path, NULL));
  assert(CreateDirectoryW(destination_path, NULL));
  assert(test_join(source_file_path, source_path, L"\\x"));
  assert(test_join(destination_file_path, destination_path, L"\\x"));
  test_write(source_file_path, "x");
  source = keiko_windows_atomic_open_directory(
      source_path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ
  );
  destination = keiko_windows_atomic_open_directory(
      destination_path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ
  );
  assert(source != INVALID_HANDLE_VALUE && destination != INVALID_HANDLE_VALUE);

  budget.entries = KEIKO_TREE_MAX_ENTRIES;
  budget.path_bytes = 0u;
  total_bytes = 0u;
  assert(!keiko_windows_update_copy_directory_contents(
      source,
      destination,
      "",
      &budget,
      &total_bytes,
      GetTickCount64() + 10000u,
      0u
  ));
  assert(GetFileAttributesW(destination_file_path) == INVALID_FILE_ATTRIBUTES);

  budget.entries = 0u;
  budget.path_bytes = KEIKO_TREE_MAX_PATH_BYTES;
  total_bytes = 0u;
  assert(!keiko_windows_update_copy_directory_contents(
      source,
      destination,
      "",
      &budget,
      &total_bytes,
      GetTickCount64() + 10000u,
      0u
  ));
  assert(GetFileAttributesW(destination_file_path) == INVALID_FILE_ATTRIBUTES);

  source_file = keiko_windows_atomic_open_regular(
      source_file_path,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(source_file != INVALID_HANDLE_VALUE);
  total_bytes = KEIKO_TREE_MAX_BYTES;
  assert(!keiko_windows_update_copy_handle(
      source_file,
      destination_file_path,
      KEIKO_TREE_MAX_FILE_BYTES,
      &total_bytes,
      GetTickCount64() + 10000u
  ));
  assert(GetFileAttributesW(destination_file_path) == INVALID_FILE_ATTRIBUTES);
  assert(CloseHandle(source_file));

  budget.entries = KEIKO_TREE_MAX_ENTRIES - 1u;
  budget.path_bytes = KEIKO_TREE_MAX_PATH_BYTES - 1u;
  total_bytes = KEIKO_TREE_MAX_BYTES - 1u;
  assert(keiko_windows_update_copy_directory_contents(
      source,
      destination,
      "",
      &budget,
      &total_bytes,
      GetTickCount64() + 10000u,
      0u
  ));
  assert(budget.entries == KEIKO_TREE_MAX_ENTRIES);
  assert(budget.path_bytes == KEIKO_TREE_MAX_PATH_BYTES);
  assert(total_bytes == KEIKO_TREE_MAX_BYTES);
  assert(CloseHandle(destination));
  assert(CloseHandle(source));
  assert(keiko_windows_update_remove_tree(root, GetTickCount64() + 10000u));
}

static void test_generation_publish_and_file_replace(void) {
  wchar_t root[TEST_PATH_CAP];
  wchar_t portable[TEST_PATH_CAP];
  wchar_t generations[TEST_PATH_CAP];
  wchar_t candidate[TEST_PATH_CAP];
  wchar_t candidate_runtime[TEST_PATH_CAP];
  wchar_t candidate_file[TEST_PATH_CAP];
  wchar_t candidate_large_file[TEST_PATH_CAP];
  wchar_t incoming[TEST_PATH_CAP];
  wchar_t published[TEST_PATH_CAP];
  wchar_t destination[TEST_PATH_CAP];
  wchar_t snapshot[TEST_PATH_CAP];
  wchar_t pending[TEST_PATH_CAP];
  char tree_digest[65];
  char file_digest[65];
  char sentinel_digest[65];
  char actual_digest[65];
  HANDLE snapshot_handle;

  test_create_root(root);
  assert(test_join(portable, root, L"\\.portable"));
  assert(CreateDirectoryW(portable, NULL));
  assert(test_join(generations, portable, L"\\generations"));
  assert(CreateDirectoryW(generations, NULL));
  assert(test_join(candidate, root, L"\\candidate"));
  assert(CreateDirectoryW(candidate, NULL));
  assert(test_join(candidate_runtime, candidate, L"\\runtime"));
  assert(CreateDirectoryW(candidate_runtime, NULL));
  assert(test_join(candidate_file, candidate_runtime, L"\\node.bin"));
  test_write(candidate_file, "candidate-generation\n");
  assert(test_join(candidate_large_file, candidate_runtime, L"\\node-large.bin"));
  test_write_sized(
      candidate_large_file,
      (uint64_t)KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES + 1u
  );
  snapshot_handle = keiko_windows_atomic_open_regular(
      candidate_large_file,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(snapshot_handle != INVALID_HANDLE_VALUE);
  assert(!keiko_windows_update_handle_hash(
      snapshot_handle,
      GetTickCount64() + 10000u,
      actual_digest
  ));
  assert(CloseHandle(snapshot_handle));
  test_tree_hash(candidate, tree_digest);

  assert(_snwprintf_s(
             incoming,
             TEST_PATH_CAP,
             _TRUNCATE,
             L"%ls\\.incoming-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
             generations
         ) > 0);
  assert(_snwprintf_s(
             published,
             TEST_PATH_CAP,
             _TRUNCATE,
             L"%ls\\%S",
             generations,
             tree_digest
         ) > 0);
  assert(keiko_windows_update_copy_publish_generation(
      candidate,
      generations,
      incoming,
      published,
      tree_digest,
      GetTickCount64() + 120000u
  ));
  assert(GetFileAttributesW(incoming) == INVALID_FILE_ATTRIBUTES);
  test_tree_hash(published, actual_digest);
  assert(strcmp(actual_digest, tree_digest) == 0);

  assert(test_join(destination, root, L"\\active.bin"));
  assert(test_join(snapshot, root, L"\\snapshot.bin"));
  assert(test_join(pending, root, L"\\.pending.bin"));
  test_write(destination, "old\n");
  test_write(snapshot, "new\n");
  snapshot_handle = keiko_windows_atomic_open_regular(
      snapshot,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(snapshot_handle != INVALID_HANDLE_VALUE);
  assert(keiko_windows_update_handle_hash(
      snapshot_handle,
      GetTickCount64() + 10000u,
      file_digest
  ));
  assert(CloseHandle(snapshot_handle));

  test_write(pending, "sentinel\n");
  snapshot_handle = keiko_windows_atomic_open_regular(
      pending,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(snapshot_handle != INVALID_HANDLE_VALUE);
  assert(keiko_windows_update_handle_hash(
      snapshot_handle,
      GetTickCount64() + 10000u,
      sentinel_digest
  ));
  assert(CloseHandle(snapshot_handle));
  assert(!keiko_windows_update_replace_file(
      snapshot,
      root,
      pending,
      destination,
      file_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_file_digest_matches(
      pending,
      sentinel_digest,
      GetTickCount64() + 10000u
  ));
  assert(DeleteFileW(pending));

  snapshot_handle = keiko_windows_atomic_open_regular(
      snapshot,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(snapshot_handle != INVALID_HANDLE_VALUE);
  assert(!keiko_windows_update_copy_handle(
      snapshot_handle,
      pending,
      KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES,
      NULL,
      0
  ));
  assert(CloseHandle(snapshot_handle));
  assert(GetFileAttributesW(pending) == INVALID_FILE_ATTRIBUTES);
  assert(GetLastError() == ERROR_FILE_NOT_FOUND);

  assert(keiko_windows_update_replace_file(
      snapshot,
      root,
      pending,
      destination,
      file_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_file_digest_matches(
      destination,
      file_digest,
      GetTickCount64() + 10000u
  ));

  assert(DeleteFileW(snapshot));
  assert(DeleteFileW(destination));
  assert(keiko_windows_update_remove_tree(root, GetTickCount64() + 10000u));
}

static void test_plan_paths_bind_exact_generation_names(void) {
  keiko_coordinator_context context;
  keiko_coordinator_windows_paths paths;
  memset(&context, 0, sizeof(context));
  context.plan.field[KEIKO_KHP_MANAGED_ROOT] = "C:\\Keiko";
  context.plan.field[KEIKO_KHP_CANDIDATE_ROOT] =
      "C:\\.keiko-portable-updates\\stage-1\\Keiko";
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  context.plan.field[KEIKO_KHP_CURRENT_GENERATION_TREE_SHA256] =
      "6666666666666666666666666666666666666666666666666666666666666666";
  context.plan.field[KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256] =
      "7777777777777777777777777777777777777777777777777777777777777777";
  assert(keiko_coordinator_windows_paths_build(&context, &paths));
  assert(wcscmp(
             paths.incoming_generation,
             L"C:\\Keiko\\.portable\\generations\\.incoming-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
         ) == 0);
  assert(wcscmp(
             paths.candidate_generation,
             L"C:\\Keiko\\.portable\\generations\\7777777777777777777777777777777777777777777777777777777777777777"
         ) == 0);
  assert(wcscmp(
             paths.candidate_source_generation,
             L"C:\\.keiko-portable-updates\\stage-1\\Keiko\\.portable\\generations\\7777777777777777777777777777777777777777777777777777777777777777"
         ) == 0);
  keiko_coordinator_windows_paths_clear(&paths);
}

static void test_shared_recovery_control_parser(void) {
  char control[] =
      "KUR1\n"
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n"
      "7\n"
      "0\n"
      "-\n"
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd\n"
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n";
  keiko_recovery_control parsed;
  memset(&parsed, 0, sizeof(parsed));
  assert(keiko_recovery_parse_control(control, &parsed));
  assert(strcmp(parsed.activation_id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") == 0);
  assert(parsed.intent_revision == 7u);
  assert(parsed.receipt_sequence == 0u);
}

int wmain(void) {
  test_copy_walk_budget_is_bounded();
  test_shared_recovery_control_parser();
  test_plan_paths_bind_exact_generation_names();
  test_generation_publish_and_file_replace();
  return 0;
}
