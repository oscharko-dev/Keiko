#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
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
      GetTickCount64() + 10000u,
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

static void test_generation_publish_and_file_replace(void) {
  wchar_t root[TEST_PATH_CAP];
  wchar_t portable[TEST_PATH_CAP];
  wchar_t generations[TEST_PATH_CAP];
  wchar_t candidate[TEST_PATH_CAP];
  wchar_t candidate_runtime[TEST_PATH_CAP];
  wchar_t candidate_file[TEST_PATH_CAP];
  wchar_t incoming[TEST_PATH_CAP];
  wchar_t published[TEST_PATH_CAP];
  wchar_t destination[TEST_PATH_CAP];
  wchar_t snapshot[TEST_PATH_CAP];
  wchar_t pending[TEST_PATH_CAP];
  char tree_digest[65];
  char file_digest[65];
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
      GetTickCount64() + 10000u
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
  test_shared_recovery_control_parser();
  test_plan_paths_bind_exact_generation_names();
  test_generation_publish_and_file_replace();
  return 0;
}
