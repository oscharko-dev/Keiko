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

static int test_atomic_flush_allowed = 1;
static unsigned int test_atomic_flush_calls = 0;
static const wchar_t *test_atomic_writer_path = NULL;
static HANDLE test_atomic_writer = INVALID_HANDLE_VALUE;
static const char *test_coordinator_cutover_failure = NULL;

static int test_atomic_replace_checkpoint(const char *name) {
  if (strcmp(name, "post-rename-before-flush") == 0) {
    test_atomic_flush_calls += 1u;
    if (test_atomic_writer_path != NULL) {
      test_atomic_writer = CreateFileW(
          test_atomic_writer_path,
          GENERIC_WRITE,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
          NULL,
          OPEN_EXISTING,
          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
          NULL
      );
      if (test_atomic_writer == INVALID_HANDLE_VALUE || test_atomic_writer == NULL) return 0;
    }
    return test_atomic_flush_allowed;
  }
  return 1;
}

#define KEIKO_WINDOWS_ATOMIC_REPLACE_CHECKPOINT(name) \
  test_atomic_replace_checkpoint(name)

#define KEIKO_COORDINATOR_CUTOVER_CHECKPOINT(name) \
  (test_coordinator_cutover_failure == NULL ||      \
   strcmp(test_coordinator_cutover_failure, name) != 0)

#include "keiko-portable-update-coordinator.h"
#include "keiko-portable-recovery-control.h"

enum { TEST_PATH_CAP = 32768 };

static void test_canonical_local_directory(
    const wchar_t *path,
    wchar_t output[TEST_PATH_CAP]
);

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

static void test_file_hash(const wchar_t *path, char output[65]) {
  HANDLE file = keiko_windows_atomic_open_regular(path, GENERIC_READ, FILE_SHARE_READ);
  assert(file != INVALID_HANDLE_VALUE && file != NULL);
  assert(keiko_windows_update_handle_hash(
      file,
      GetTickCount64() + 10000u,
      output
  ));
  assert(CloseHandle(file));
}

static void test_create_root(wchar_t root[TEST_PATH_CAP]) {
  wchar_t *temporary = (wchar_t *)calloc(TEST_PATH_CAP, sizeof(wchar_t));
  assert(temporary != NULL);
  DWORD length = GetTempPathW(TEST_PATH_CAP, temporary);
  assert(length > 0 && length < TEST_PATH_CAP);
  assert(GetTempFileNameW(temporary, L"kwc", 0, root) != 0);
  assert(DeleteFileW(root));
  assert(CreateDirectoryW(root, NULL));
  test_canonical_local_directory(root, root);
  free(temporary);
}

static void test_canonical_local_directory(
    const wchar_t *path,
    wchar_t output[TEST_PATH_CAP]
) {
  HANDLE directory = keiko_windows_atomic_open_directory(
      path,
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE
  );
  assert(directory != INVALID_HANDLE_VALUE && directory != NULL);
  assert(keiko_windows_local_volume_final_path(directory, output));
  assert(CloseHandle(directory));
}

static void test_directory_owner_policy(void) {
  BYTE user_storage[SECURITY_MAX_SID_SIZE];
  BYTE system_storage[SECURITY_MAX_SID_SIZE];
  BYTE administrators_storage[SECURITY_MAX_SID_SIZE];
  BYTE users_storage[SECURITY_MAX_SID_SIZE];
  DWORD user_size = sizeof(user_storage);
  DWORD system_size = sizeof(system_storage);
  DWORD administrators_size = sizeof(administrators_storage);
  DWORD users_size = sizeof(users_storage);
  assert(CreateWellKnownSid(WinCreatorOwnerSid, NULL, user_storage, &user_size));
  assert(CreateWellKnownSid(WinLocalSystemSid, NULL, system_storage, &system_size));
  assert(CreateWellKnownSid(
      WinBuiltinAdministratorsSid,
      NULL,
      administrators_storage,
      &administrators_size
  ));
  assert(CreateWellKnownSid(WinBuiltinUsersSid, NULL, users_storage, &users_size));
  assert(keiko_coordinator_windows_owner_private(
      user_storage,
      user_storage,
      user_storage,
      system_storage,
      administrators_storage
  ));
  assert(keiko_coordinator_windows_owner_private(
      administrators_storage,
      user_storage,
      administrators_storage,
      system_storage,
      administrators_storage
  ));
  assert(keiko_coordinator_windows_owner_private(
      system_storage,
      user_storage,
      system_storage,
      system_storage,
      administrators_storage
  ));
  assert(!keiko_coordinator_windows_owner_private(
      users_storage,
      user_storage,
      users_storage,
      system_storage,
      administrators_storage
  ));
  assert(!keiko_coordinator_windows_owner_private(
      administrators_storage,
      user_storage,
      user_storage,
      system_storage,
      administrators_storage
  ));
}

static int test_create_junction(const wchar_t *link, const wchar_t *target) {
  typedef struct {
    wchar_t system[TEST_PATH_CAP];
    wchar_t executable[TEST_PATH_CAP];
    wchar_t command[TEST_PATH_CAP * 3u];
  } command_paths;
  command_paths *paths = (command_paths *)calloc(1u, sizeof(*paths));
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  DWORD exit_code = 1;
  int result = 0;
  if (paths == NULL) return 0;
  memset(&startup, 0, sizeof(startup));
  memset(&process, 0, sizeof(process));
  startup.cb = sizeof(startup);
  if (GetSystemDirectoryW(paths->system, TEST_PATH_CAP) == 0 ||
      !test_join(paths->executable, paths->system, L"\\cmd.exe") ||
      _snwprintf_s(
          paths->command,
          TEST_PATH_CAP * 3u,
          _TRUNCATE,
          L"\"%ls\" /d /s /c mklink /J \"%ls\" \"%ls\"",
          paths->executable,
          link,
          target
      ) <= 0 ||
      !CreateProcessW(
          paths->executable,
          paths->command,
          NULL,
          NULL,
          FALSE,
          CREATE_NO_WINDOW,
          NULL,
          NULL,
          &startup,
          &process
      )) goto cleanup;
  if (WaitForSingleObject(process.hProcess, 10000u) == WAIT_OBJECT_0 &&
      GetExitCodeProcess(process.hProcess, &exit_code) && exit_code == 0u) result = 1;
cleanup:
  if (process.hThread != NULL) CloseHandle(process.hThread);
  if (process.hProcess != NULL) CloseHandle(process.hProcess);
  free(paths);
  return result;
}

static void test_copy_walk_budget_is_bounded(void) {
  typedef struct {
    wchar_t root[TEST_PATH_CAP];
    wchar_t source[TEST_PATH_CAP];
    wchar_t destination[TEST_PATH_CAP];
    wchar_t source_file[TEST_PATH_CAP];
    wchar_t destination_file[TEST_PATH_CAP];
  } test_paths;
  test_paths *paths = (test_paths *)calloc(1u, sizeof(*paths));
  HANDLE source;
  HANDLE destination;
  HANDLE source_file;
  keiko_tree_walk_budget budget;
  uint64_t total_bytes;
  assert(paths != NULL);
  test_create_root(paths->root);
  assert(test_join(paths->source, paths->root, L"\\source"));
  assert(test_join(paths->destination, paths->root, L"\\destination"));
  assert(CreateDirectoryW(paths->source, NULL));
  assert(CreateDirectoryW(paths->destination, NULL));
  assert(test_join(paths->source_file, paths->source, L"\\x"));
  assert(test_join(paths->destination_file, paths->destination, L"\\x"));
  test_write(paths->source_file, "x");
  source = keiko_windows_atomic_open_directory(
      paths->source,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ
  );
  destination = keiko_windows_atomic_open_directory(
      paths->destination,
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
  assert(GetFileAttributesW(paths->destination_file) == INVALID_FILE_ATTRIBUTES);

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
  assert(GetFileAttributesW(paths->destination_file) == INVALID_FILE_ATTRIBUTES);

  source_file = keiko_windows_atomic_open_regular(
      paths->source_file,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(source_file != INVALID_HANDLE_VALUE);
  total_bytes = KEIKO_TREE_MAX_BYTES;
  assert(!keiko_windows_update_copy_handle(
      source_file,
      paths->destination_file,
      KEIKO_TREE_MAX_FILE_BYTES,
      &total_bytes,
      GetTickCount64() + 10000u
  ));
  assert(GetFileAttributesW(paths->destination_file) == INVALID_FILE_ATTRIBUTES);
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
  assert(keiko_windows_update_remove_tree(paths->root, GetTickCount64() + 10000u));
  free(paths);
}

static void test_generation_publish_and_file_replace(void) {
  typedef struct {
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
  } test_paths;
  test_paths *paths = (test_paths *)calloc(1u, sizeof(*paths));
  char tree_digest[65];
  char file_digest[65];
  char sentinel_digest[65];
  char actual_digest[65];
  HANDLE snapshot_handle;

  assert(paths != NULL);
  test_create_root(paths->root);
  assert(test_join(paths->portable, paths->root, L"\\.portable"));
  assert(CreateDirectoryW(paths->portable, NULL));
  assert(test_join(paths->generations, paths->portable, L"\\generations"));
  assert(CreateDirectoryW(paths->generations, NULL));
  assert(test_join(paths->candidate, paths->root, L"\\candidate"));
  assert(CreateDirectoryW(paths->candidate, NULL));
  assert(test_join(paths->candidate_runtime, paths->candidate, L"\\runtime"));
  assert(CreateDirectoryW(paths->candidate_runtime, NULL));
  assert(test_join(paths->candidate_file, paths->candidate_runtime, L"\\node.bin"));
  test_write(paths->candidate_file, "candidate-generation\n");
  assert(test_join(
      paths->candidate_large_file,
      paths->candidate_runtime,
      L"\\node-large.bin"
  ));
  test_write_sized(
      paths->candidate_large_file,
      (uint64_t)KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES + 1u
  );
  snapshot_handle = keiko_windows_atomic_open_regular(
      paths->candidate_large_file,
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
  test_tree_hash(paths->candidate, tree_digest);

  assert(_snwprintf_s(
             paths->incoming,
             TEST_PATH_CAP,
             _TRUNCATE,
             L"%ls\\.incoming-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
             paths->generations
         ) > 0);
  assert(_snwprintf_s(
             paths->published,
             TEST_PATH_CAP,
             _TRUNCATE,
             L"%ls\\%S",
             paths->generations,
             tree_digest
         ) > 0);
  assert(keiko_windows_update_copy_publish_generation(
      paths->candidate,
      paths->generations,
      paths->incoming,
      paths->published,
      tree_digest,
      GetTickCount64() + 120000u
  ));
  assert(GetFileAttributesW(paths->incoming) == INVALID_FILE_ATTRIBUTES);
  test_tree_hash(paths->published, actual_digest);
  assert(strcmp(actual_digest, tree_digest) == 0);

  assert(test_join(paths->destination, paths->root, L"\\active.bin"));
  assert(test_join(paths->snapshot, paths->root, L"\\snapshot.bin"));
  assert(test_join(paths->pending, paths->root, L"\\.pending.bin"));
  test_write(paths->destination, "old\n");
  test_write(paths->snapshot, "new\n");
  snapshot_handle = keiko_windows_atomic_open_regular(
      paths->snapshot,
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

  test_write(paths->pending, "sentinel\n");
  snapshot_handle = keiko_windows_atomic_open_regular(
      paths->pending,
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
      paths->snapshot,
      paths->root,
      paths->pending,
      paths->destination,
      file_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_file_digest_matches(
      paths->pending,
      sentinel_digest,
      GetTickCount64() + 10000u
  ));
  assert(DeleteFileW(paths->pending));

  snapshot_handle = keiko_windows_atomic_open_regular(
      paths->snapshot,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(snapshot_handle != INVALID_HANDLE_VALUE);
  assert(!keiko_windows_update_copy_handle(
      snapshot_handle,
      paths->pending,
      KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES,
      NULL,
      0
  ));
  assert(CloseHandle(snapshot_handle));
  assert(GetFileAttributesW(paths->pending) == INVALID_FILE_ATTRIBUTES);
  assert(GetLastError() == ERROR_FILE_NOT_FOUND);

  assert(keiko_windows_update_replace_file(
      paths->snapshot,
      paths->root,
      paths->pending,
      paths->destination,
      file_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_file_digest_matches(
      paths->destination,
      file_digest,
      GetTickCount64() + 10000u
  ));

  assert(DeleteFileW(paths->snapshot));
  assert(DeleteFileW(paths->destination));
  assert(keiko_windows_update_remove_tree(paths->root, GetTickCount64() + 10000u));
  free(paths);
}

static void test_productive_file_cutovers_flush_and_recover(void) {
  typedef struct {
    wchar_t root[TEST_PATH_CAP];
    wchar_t portable[TEST_PATH_CAP];
    wchar_t state[TEST_PATH_CAP];
    wchar_t destination[3][TEST_PATH_CAP];
    wchar_t snapshot[3][TEST_PATH_CAP];
    wchar_t temporary[3][TEST_PATH_CAP];
    wchar_t previous[TEST_PATH_CAP];
    wchar_t fault_snapshot[TEST_PATH_CAP];
    wchar_t fault_temporary[TEST_PATH_CAP];
    wchar_t restore_temporary[TEST_PATH_CAP];
  } test_paths;
  static const wchar_t *destination_names[3] = {
      L"\\Keiko.exe",
      L"\\setup-manifest.json",
      L"\\portable-install-state.json"};
  static const wchar_t *snapshot_names[3] = {
      L"\\launcher.next",
      L"\\setup-manifest.next",
      L"\\registration.next"};
  static const wchar_t *temporary_names[3] = {
      L"\\.launcher-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      L"\\.setup-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      L"\\.registration-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"};
  static const char *candidate_content[3] = {
      "launcher-candidate\n",
      "setup-candidate\n",
      "registration-candidate\n"};
  test_paths *paths = (test_paths *)calloc(1u, sizeof(*paths));
  char digest[65];
  char previous_digest[65];
  char fault_digest[65];
  const wchar_t *parent[3];
  size_t index;
  assert(paths != NULL);
  test_create_root(paths->root);
  assert(test_join(paths->portable, paths->root, L"\\.portable"));
  assert(test_join(paths->state, paths->root, L"\\state"));
  assert(CreateDirectoryW(paths->portable, NULL));
  assert(CreateDirectoryW(paths->state, NULL));
  parent[0] = paths->root;
  parent[1] = paths->portable;
  parent[2] = paths->state;
  test_atomic_flush_calls = 0u;
  test_atomic_flush_allowed = 1;
  for (index = 0; index < 3u; ++index) {
    assert(test_join(paths->destination[index], parent[index], destination_names[index]));
    assert(test_join(paths->snapshot[index], paths->root, snapshot_names[index]));
    assert(test_join(paths->temporary[index], parent[index], temporary_names[index]));
    test_write(paths->destination[index], "previous\n");
    test_write(paths->snapshot[index], candidate_content[index]);
    test_file_hash(paths->snapshot[index], digest);
    assert(keiko_windows_update_replace_file(
        paths->snapshot[index],
        parent[index],
        paths->temporary[index],
        paths->destination[index],
        digest,
        GetTickCount64() + 10000u
    ));
    assert(keiko_windows_update_file_digest_matches(
        paths->destination[index],
        digest,
        GetTickCount64() + 10000u
    ));
  }
  assert(test_atomic_flush_calls == 3u);

  assert(test_join(paths->previous, paths->root, L"\\registration.previous"));
  assert(test_join(paths->fault_snapshot, paths->root, L"\\registration.fault.next"));
  assert(test_join(
      paths->fault_temporary,
      paths->state,
      L"\\.registration-fault-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ));
  assert(test_join(
      paths->restore_temporary,
      paths->state,
      L"\\.registration-restore-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ));
  test_write(paths->previous, "registration-previous\n");
  test_write(paths->fault_snapshot, "registration-fault-candidate\n");
  test_file_hash(paths->previous, previous_digest);
  test_file_hash(paths->fault_snapshot, fault_digest);
  test_atomic_writer_path = paths->destination[2];
  assert(!keiko_windows_update_replace_file(
      paths->fault_snapshot,
      paths->state,
      paths->fault_temporary,
      paths->destination[2],
      fault_digest,
      GetTickCount64() + 10000u
  ));
  assert(test_atomic_writer != INVALID_HANDLE_VALUE && test_atomic_writer != NULL);
  assert(CloseHandle(test_atomic_writer));
  test_atomic_writer = INVALID_HANDLE_VALUE;
  test_atomic_writer_path = NULL;
  assert(keiko_windows_update_file_digest_matches(
      paths->destination[2],
      fault_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_replace_file(
      paths->previous,
      paths->state,
      paths->restore_temporary,
      paths->destination[2],
      previous_digest,
      GetTickCount64() + 10000u
  ));
  test_atomic_flush_allowed = 0;
  assert(!keiko_windows_update_replace_file(
      paths->fault_snapshot,
      paths->state,
      paths->fault_temporary,
      paths->destination[2],
      fault_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_file_digest_matches(
      paths->destination[2],
      fault_digest,
      GetTickCount64() + 10000u
  ));
  test_atomic_flush_allowed = 1;
  assert(keiko_windows_update_replace_file(
      paths->previous,
      paths->state,
      paths->restore_temporary,
      paths->destination[2],
      previous_digest,
      GetTickCount64() + 10000u
  ));
  assert(keiko_windows_update_file_digest_matches(
      paths->destination[2],
      previous_digest,
      GetTickCount64() + 10000u
  ));
  assert(test_atomic_flush_calls == 7u);
  assert(keiko_windows_update_remove_tree(paths->root, GetTickCount64() + 10000u));
  free(paths);
}

typedef struct {
  wchar_t root[TEST_PATH_CAP];
  wchar_t managed[TEST_PATH_CAP];
  wchar_t portable[TEST_PATH_CAP];
  wchar_t generations[TEST_PATH_CAP];
  wchar_t current_generation[TEST_PATH_CAP];
  wchar_t stage[TEST_PATH_CAP];
  wchar_t candidate[TEST_PATH_CAP];
  wchar_t candidate_portable[TEST_PATH_CAP];
  wchar_t candidate_generations[TEST_PATH_CAP];
  wchar_t candidate_generation[TEST_PATH_CAP];
  wchar_t candidate_launcher[TEST_PATH_CAP];
  wchar_t candidate_supervisor[TEST_PATH_CAP];
  wchar_t current_supervisor[TEST_PATH_CAP];
  wchar_t launcher[TEST_PATH_CAP];
  wchar_t setup[TEST_PATH_CAP];
  wchar_t state[TEST_PATH_CAP];
  wchar_t registration[TEST_PATH_CAP];
  wchar_t capsule[TEST_PATH_CAP];
  wchar_t backup[TEST_PATH_CAP];
  wchar_t snapshot[TEST_PATH_CAP];
  char current_generation_sha256[65];
  char candidate_generation_sha256[65];
  char current_launcher_sha256[65];
  char candidate_launcher_sha256[65];
  char current_setup_sha256[65];
  char candidate_setup_sha256[65];
  char previous_registration_sha256[65];
  char prepared_registration_sha256[65];
  char current_supervisor_sha256[65];
  char candidate_supervisor_sha256[65];
  keiko_coordinator_context context;
} windows_cutover_fixture;

typedef struct {
  wchar_t seed[TEST_PATH_CAP];
  wchar_t runtime[TEST_PATH_CAP];
  wchar_t native[TEST_PATH_CAP];
} test_generation_paths;

static void test_create_generation(
    const wchar_t *generations,
    const wchar_t *seed_name,
    const char *content,
    wchar_t output[TEST_PATH_CAP],
    wchar_t supervisor[TEST_PATH_CAP],
    char digest[65]
) {
  test_generation_paths *paths =
      (test_generation_paths *)calloc(1u, sizeof(*paths));
  assert(paths != NULL);
  assert(test_join(paths->seed, generations, seed_name));
  assert(CreateDirectoryW(paths->seed, NULL));
  assert(test_join(paths->runtime, paths->seed, L"\\runtime"));
  assert(CreateDirectoryW(paths->runtime, NULL));
  assert(test_join(paths->native, paths->runtime, L"\\native"));
  assert(CreateDirectoryW(paths->native, NULL));
  assert(test_join(supervisor, paths->native, L"\\keiko-runtime-supervisor.exe"));
  test_write(supervisor, content);
  test_tree_hash(paths->seed, digest);
  assert(_snwprintf_s(output, TEST_PATH_CAP, _TRUNCATE, L"%ls\\%S", generations, digest) > 0);
  assert(MoveFileExW(paths->seed, output, MOVEFILE_WRITE_THROUGH));
  assert(test_join(supervisor, output, L"\\runtime\\native\\keiko-runtime-supervisor.exe"));
  free(paths);
}

static void test_plan_field(
    keiko_coordinator_context *context,
    int field,
    const char *value
) {
  context->plan.field[field] = _strdup(value);
  assert(context->plan.field[field] != NULL);
}

static void test_plan_path(
    keiko_coordinator_context *context,
    int field,
    const wchar_t *value
) {
  context->plan.field[field] = keiko_coordinator_windows_utf8_wide(value);
  assert(context->plan.field[field] != NULL);
}

static void windows_cutover_fixture_init(windows_cutover_fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  test_create_root(fixture->root);
  assert(test_join(fixture->managed, fixture->root, L"\\managed"));
  assert(CreateDirectoryW(fixture->managed, NULL));
  assert(test_join(fixture->portable, fixture->managed, L"\\.portable"));
  assert(CreateDirectoryW(fixture->portable, NULL));
  assert(test_join(fixture->generations, fixture->portable, L"\\generations"));
  assert(CreateDirectoryW(fixture->generations, NULL));
  test_create_generation(
      fixture->generations,
      L"\\current-seed",
      "current supervisor\n",
      fixture->current_generation,
      fixture->current_supervisor,
      fixture->current_generation_sha256
  );
  test_file_hash(fixture->current_supervisor, fixture->current_supervisor_sha256);

  assert(test_join(fixture->stage, fixture->root, L"\\stage"));
  assert(CreateDirectoryW(fixture->stage, NULL));
  assert(test_join(fixture->candidate, fixture->stage, L"\\Keiko"));
  assert(CreateDirectoryW(fixture->candidate, NULL));
  assert(test_join(fixture->candidate_portable, fixture->candidate, L"\\.portable"));
  assert(CreateDirectoryW(fixture->candidate_portable, NULL));
  assert(test_join(
      fixture->candidate_generations,
      fixture->candidate_portable,
      L"\\generations"
  ));
  assert(CreateDirectoryW(fixture->candidate_generations, NULL));
  test_create_generation(
      fixture->candidate_generations,
      L"\\candidate-seed",
      "candidate supervisor\n",
      fixture->candidate_generation,
      fixture->candidate_supervisor,
      fixture->candidate_generation_sha256
  );
  test_file_hash(fixture->candidate_supervisor, fixture->candidate_supervisor_sha256);

  assert(test_join(fixture->launcher, fixture->managed, L"\\Keiko.exe"));
  test_write(fixture->launcher, "current launcher\n");
  test_file_hash(fixture->launcher, fixture->current_launcher_sha256);
  assert(test_join(fixture->candidate_launcher, fixture->candidate, L"\\Keiko.exe"));
  test_write(fixture->candidate_launcher, "candidate launcher\n");
  test_file_hash(fixture->candidate_launcher, fixture->candidate_launcher_sha256);
  assert(test_join(fixture->setup, fixture->portable, L"\\setup-manifest.json"));
  test_write(fixture->setup, "current setup\n");
  test_file_hash(fixture->setup, fixture->current_setup_sha256);
  assert(test_join(fixture->state, fixture->root, L"\\state"));
  assert(CreateDirectoryW(fixture->state, NULL));
  assert(test_join(fixture->registration, fixture->state, L"\\portable-install-state.json"));
  test_write(fixture->registration, "previous registration\n");
  test_file_hash(fixture->registration, fixture->previous_registration_sha256);
  assert(test_join(fixture->capsule, fixture->root, L"\\capsule"));
  assert(CreateDirectoryW(fixture->capsule, NULL));
  assert(test_join(fixture->backup, fixture->root, L"\\backup"));

  assert(test_join(fixture->snapshot, fixture->capsule, L"\\coordinator.exe"));
  test_write(fixture->snapshot, "current launcher\n");
  assert(test_join(fixture->snapshot, fixture->capsule, L"\\launcher.next"));
  test_write(fixture->snapshot, "candidate launcher\n");
  assert(test_join(fixture->snapshot, fixture->capsule, L"\\setup-manifest.previous"));
  test_write(fixture->snapshot, "current setup\n");
  assert(test_join(fixture->snapshot, fixture->capsule, L"\\setup-manifest.next"));
  test_write(fixture->snapshot, "candidate setup\n");
  test_file_hash(fixture->snapshot, fixture->candidate_setup_sha256);
  assert(test_join(fixture->snapshot, fixture->capsule, L"\\registration.previous"));
  test_write(fixture->snapshot, "previous registration\n");
  assert(test_join(fixture->snapshot, fixture->capsule, L"\\registration.next"));
  test_write(fixture->snapshot, "prepared registration\n");
  test_file_hash(fixture->snapshot, fixture->prepared_registration_sha256);

  fixture->context.supervisor_control = -1;
  fixture->context.supervisor_response = -1;
  fixture->context.start_gate = -1;
  fixture->context.managed_root.directory = INVALID_HANDLE_VALUE;
  fixture->context.state_dir = _wcsdup(fixture->state);
  fixture->context.capsule = _wcsdup(fixture->capsule);
  assert(fixture->context.state_dir != NULL && fixture->context.capsule != NULL);
  memset(fixture->context.plan_sha256, 'f', 64u);
  fixture->context.plan_sha256[64] = '\0';
  test_plan_field(
      &fixture->context,
      KEIKO_KHP_ACTIVATION_ID,
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  test_plan_path(&fixture->context, KEIKO_KHP_MANAGED_ROOT, fixture->managed);
  test_plan_path(&fixture->context, KEIKO_KHP_STAGE_ROOT, fixture->stage);
  test_plan_path(&fixture->context, KEIKO_KHP_CANDIDATE_ROOT, fixture->candidate);
  test_plan_path(&fixture->context, KEIKO_KHP_BACKUP_ROOT, fixture->backup);
  test_plan_path(
      &fixture->context,
      KEIKO_KHP_CANDIDATE_LAUNCHER,
      fixture->candidate_launcher
  );
  test_plan_path(
      &fixture->context,
      KEIKO_KHP_CANDIDATE_SUPERVISOR,
      fixture->candidate_supervisor
  );
  test_plan_field(&fixture->context, KEIKO_KHP_CURRENT_TREE_SHA256,
                  fixture->current_generation_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CANDIDATE_TREE_SHA256,
                  fixture->candidate_generation_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CURRENT_GENERATION_TREE_SHA256,
                  fixture->current_generation_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CANDIDATE_GENERATION_TREE_SHA256,
                  fixture->candidate_generation_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CURRENT_LAUNCHER_SHA256,
                  fixture->current_launcher_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256,
                  fixture->candidate_launcher_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CURRENT_SETUP_MANIFEST_SHA256,
                  fixture->current_setup_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CANDIDATE_SETUP_MANIFEST_SHA256,
                  fixture->candidate_setup_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256,
                  fixture->previous_registration_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_PREPARED_REGISTRATION_SHA256,
                  fixture->prepared_registration_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CURRENT_SUPERVISOR_SHA256,
                  fixture->current_supervisor_sha256);
  test_plan_field(&fixture->context, KEIKO_KHP_CANDIDATE_SUPERVISOR_SHA256,
                  fixture->candidate_supervisor_sha256);
  assert(keiko_coordinator_windows_roots_same_volume(&fixture->context));
}

static void windows_cutover_fixture_clear(windows_cutover_fixture *fixture) {
  test_coordinator_cutover_failure = NULL;
  keiko_coordinator_clear(&fixture->context);
  assert(keiko_windows_update_remove_tree(
      fixture->root,
      GetTickCount64() + 120000u
  ));
}

static void test_windows_cutover_checkpoint(
    const char *checkpoint,
    int expected_prefix
) {
  windows_cutover_fixture *fixture =
      (windows_cutover_fixture *)calloc(1u, sizeof(*fixture));
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  assert(fixture != NULL);
  windows_cutover_fixture_init(fixture);
  test_coordinator_cutover_failure = checkpoint;
  assert(!keiko_coordinator_promote_windows(
      &fixture->context,
      GetTickCount64() + 120000u
  ));
  assert(keiko_coordinator_windows_classify(
      &fixture->context,
      GetTickCount64() + 120000u,
      &prefix
  ));
  assert(prefix == expected_prefix);
  test_coordinator_cutover_failure = NULL;
  assert(keiko_coordinator_restore_platform_windows(
      &fixture->context,
      GetTickCount64() + 120000u
  ));
  assert(keiko_coordinator_windows_classify(
      &fixture->context,
      GetTickCount64() + 120000u,
      &prefix
  ));
  assert(prefix == KEIKO_WINDOWS_PREFIX_PREVIOUS);
  windows_cutover_fixture_clear(fixture);
  free(fixture);
}

static void test_windows_cutover_checkpoints_are_recoverable(void) {
  windows_cutover_fixture *fixture;
  int prefix = KEIKO_WINDOWS_PREFIX_INVALID;
  test_windows_cutover_checkpoint(
      "windows-promote-after-generation",
      KEIKO_WINDOWS_PREFIX_GENERATION
  );
  test_windows_cutover_checkpoint(
      "windows-promote-after-launcher",
      KEIKO_WINDOWS_PREFIX_LAUNCHER
  );
  test_windows_cutover_checkpoint(
      "windows-promote-after-setup",
      KEIKO_WINDOWS_PREFIX_SETUP
  );

  fixture = (windows_cutover_fixture *)calloc(1u, sizeof(*fixture));
  assert(fixture != NULL);
  windows_cutover_fixture_init(fixture);
  assert(keiko_coordinator_promote_windows(
      &fixture->context,
      GetTickCount64() + 120000u
  ));
  test_coordinator_cutover_failure = "windows-register-after-publish";
  assert(!keiko_coordinator_publish_registration_windows(
      &fixture->context,
      GetTickCount64() + 120000u
  ));
  assert(keiko_coordinator_windows_classify(
      &fixture->context,
      GetTickCount64() + 120000u,
      &prefix
  ));
  assert(prefix == KEIKO_WINDOWS_PREFIX_REGISTRATION);
  test_coordinator_cutover_failure = NULL;
  assert(keiko_coordinator_restore_platform_windows(
      &fixture->context,
      GetTickCount64() + 120000u
  ));
  assert(keiko_coordinator_windows_classify(
      &fixture->context,
      GetTickCount64() + 120000u,
      &prefix
  ));
  assert(prefix == KEIKO_WINDOWS_PREFIX_PREVIOUS);
  windows_cutover_fixture_clear(fixture);
  free(fixture);
}

static void test_capsule_and_receipt_junctions_are_refused(void) {
  typedef struct {
    wchar_t root[TEST_PATH_CAP];
    wchar_t outside_capsule[TEST_PATH_CAP];
    wchar_t capsule_link[TEST_PATH_CAP];
    wchar_t capsule[TEST_PATH_CAP];
    wchar_t outside_receipts[TEST_PATH_CAP];
    wchar_t receipts_link[TEST_PATH_CAP];
    wchar_t escaped_receipt[TEST_PATH_CAP];
  } test_paths;
  test_paths *paths = (test_paths *)calloc(1u, sizeof(*paths));
  keiko_coordinator_context context;
  keiko_windows_local_volume_pin locality_pin;
  DWORD attributes;
  assert(paths != NULL);
  memset(&context, 0, sizeof(context));
  test_create_root(paths->root);
  assert(test_join(paths->outside_capsule, paths->root, L"\\outside-capsule"));
  assert(test_join(paths->capsule_link, paths->root, L"\\capsule-link"));
  assert(CreateDirectoryW(paths->outside_capsule, NULL));
  assert(test_create_junction(paths->capsule_link, paths->outside_capsule));
  assert(!keiko_windows_local_volume_pin_path(paths->capsule_link, 1, &locality_pin));
  context.capsule = paths->capsule_link;
  assert(!keiko_coordinator_windows_pin_capsule(&context));
  assert(RemoveDirectoryW(paths->capsule_link));

  assert(test_join(paths->capsule, paths->root, L"\\capsule"));
  assert(test_join(paths->outside_receipts, paths->root, L"\\outside-receipts"));
  assert(test_join(paths->receipts_link, paths->capsule, L"\\receipts"));
  assert(test_join(paths->escaped_receipt, paths->outside_receipts, L"\\000001.khr"));
  assert(CreateDirectoryW(paths->capsule, NULL));
  assert(CreateDirectoryW(paths->outside_receipts, NULL));
  assert(test_create_junction(paths->receipts_link, paths->outside_receipts));
  context.capsule = paths->capsule;
  assert(keiko_coordinator_windows_pin_capsule(&context));
  assert(!keiko_coordinator_windows_pin_receipts(&context, 0));
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] =
      _strdup("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert(context.plan.field[KEIKO_KHP_ACTIVATION_ID] != NULL);
  memset(context.plan_sha256, 'b', 64u);
  context.plan_sha256[64] = '\0';
  assert(!keiko_coordinator_windows_append_receipt(&context, "prepared", "completed"));
  attributes = GetFileAttributesW(paths->escaped_receipt);
  assert(attributes == INVALID_FILE_ATTRIBUTES);
  assert(GetLastError() == ERROR_FILE_NOT_FOUND);
  free(context.plan.field[KEIKO_KHP_ACTIVATION_ID]);
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] = NULL;
  if (context.receipts_directory != NULL &&
      context.receipts_directory != INVALID_HANDLE_VALUE)
    assert(CloseHandle(context.receipts_directory));
  if (context.capsule_directory != NULL &&
      context.capsule_directory != INVALID_HANDLE_VALUE)
    assert(CloseHandle(context.capsule_directory));
  assert(RemoveDirectoryW(paths->receipts_link));
  assert(keiko_windows_update_remove_tree(paths->root, GetTickCount64() + 10000u));
  free(paths);
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

static void test_coordinator_pins_local_managed_root(void) {
  typedef struct {
    wchar_t original_root[TEST_PATH_CAP];
    wchar_t root[TEST_PATH_CAP];
    wchar_t managed[TEST_PATH_CAP];
    wchar_t stage[TEST_PATH_CAP];
    wchar_t renamed[TEST_PATH_CAP];
  } test_paths;
  test_paths *paths = (test_paths *)calloc(1u, sizeof(*paths));
  keiko_coordinator_context context;
  assert(paths != NULL);
  memset(&context, 0, sizeof(context));
  test_create_root(paths->original_root);
  test_canonical_local_directory(paths->original_root, paths->root);
  assert(test_join(paths->managed, paths->root, L"\\managed"));
  assert(test_join(paths->stage, paths->root, L"\\stage"));
  assert(test_join(paths->renamed, paths->root, L"\\managed-renamed"));
  assert(CreateDirectoryW(paths->managed, NULL));
  assert(CreateDirectoryW(paths->stage, NULL));
  context.plan.field[KEIKO_KHP_MANAGED_ROOT] =
      keiko_coordinator_windows_utf8_wide(paths->managed);
  context.plan.field[KEIKO_KHP_STAGE_ROOT] =
      keiko_coordinator_windows_utf8_wide(paths->stage);
  assert(context.plan.field[KEIKO_KHP_MANAGED_ROOT] != NULL);
  assert(context.plan.field[KEIKO_KHP_STAGE_ROOT] != NULL);
  assert(keiko_coordinator_windows_roots_same_volume(&context));
  assert(keiko_coordinator_windows_managed_root_current(&context));
  assert(!MoveFileExW(paths->managed, paths->renamed, MOVEFILE_WRITE_THROUGH));
  keiko_windows_local_volume_clear(&context.managed_root);
  free(context.plan.field[KEIKO_KHP_STAGE_ROOT]);
  free(context.plan.field[KEIKO_KHP_MANAGED_ROOT]);
  context.plan.field[KEIKO_KHP_STAGE_ROOT] = NULL;
  context.plan.field[KEIKO_KHP_MANAGED_ROOT] = NULL;
  assert(keiko_windows_update_remove_tree(paths->root, GetTickCount64() + 10000u));
  free(paths);
}

static void test_recovery_runtime_and_lock_binding(void) {
  typedef struct {
    wchar_t root[TEST_PATH_CAP];
    wchar_t updates[TEST_PATH_CAP];
    wchar_t runtime_path[TEST_PATH_CAP];
    wchar_t lock_path[TEST_PATH_CAP];
  } test_paths;
  test_paths *paths = (test_paths *)calloc(1u, sizeof(*paths));
  wchar_t *child_stem;
  wchar_t *child_path;
  char identity_json[1024];
  char child_json[1024];
  char identity[65];
  char runtime_sha256[65];
  char session_sha256[65];
  keiko_coordinator_context context;
  keiko_recovery_control control;
  HANDLE file;
  int written;
  memset(&context, 0, sizeof(context));
  memset(&control, 0, sizeof(control));
  assert(paths != NULL);
  test_create_root(paths->root);
  assert(test_join(paths->updates, paths->root, L"\\updates"));
  assert(CreateDirectoryW(paths->updates, NULL));
  assert(test_join(paths->runtime_path, paths->updates, L"\\runtime-state.json"));
  assert(test_join(paths->lock_path, paths->updates, L"\\update-session.lock"));
  test_write(paths->runtime_path, "{\"activationWal\":{}}\n");
  file = keiko_windows_atomic_open_regular(
      paths->runtime_path,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  assert(file != INVALID_HANDLE_VALUE);
  assert(keiko_windows_update_handle_hash(
      file,
      GetTickCount64() + 10000u,
      runtime_sha256
  ));
  assert(CloseHandle(file));
  written = snprintf(
      identity_json,
      sizeof(identity_json),
      "{\"sessionId\":\"session-1\",\"targetVersion\":\"1.2.3\","
      "\"startedAt\":\"2026-09-07T00:00:00.000Z\",\"pid\":42,"
      "\"processIdentity\":\"process-1\"}"
  );
  assert(written > 0 && (size_t)written < sizeof(identity_json));
  assert(keiko_coordinator_windows_hash_bytes(identity_json, (size_t)written, identity));
  assert(keiko_coordinator_windows_hash_bytes(
      "session-1",
      strlen("session-1"),
      session_sha256
  ));
  assert(_snwprintf_s(
             paths->lock_path,
             TEST_PATH_CAP,
             _TRUNCATE,
             L"%ls\\update-session.lock",
             paths->updates
         ) > 0);
  written = snprintf(identity_json + written, sizeof(identity_json) - (size_t)written, "\n");
  assert(written == 1);
  test_write(paths->lock_path, identity_json);
  child_stem = keiko_coordinator_windows_ascii_path(
      paths->updates,
      L"\\update-session.lock.",
      session_sha256
  );
  assert(child_stem != NULL);
  child_path = keiko_windows_update_path_join(child_stem, L".child");
  assert(child_path != NULL);
  written = snprintf(
      child_json,
      sizeof(child_json),
      "{\"sessionId\":\"session-1\",\"lockIdentity\":\"%s\",\"childPid\":%lu}\n",
      identity,
      (unsigned long)GetCurrentProcessId()
  );
  assert(written > 0 && (size_t)written < sizeof(child_json));
  test_write(child_path, child_json);
  context.state_dir = paths->root;
  context.plan.field[KEIKO_KHP_SESSION_ID] = "session-1";
  context.plan.field[KEIKO_KHP_TARGET_VERSION] = "1.2.3";
  control.runtime_state_sha256 = runtime_sha256;
  control.lock_identity = identity;
  assert(keiko_recovery_validate_runtime_windows(
      &context,
      &control,
      GetTickCount64() + 10000u
  ));
  assert(keiko_recovery_validate_lock_windows(
      &context,
      &control,
      GetTickCount64() + 10000u
  ));
  control.lock_identity = runtime_sha256;
  assert(!keiko_recovery_validate_lock_windows(
      &context,
      &control,
      GetTickCount64() + 10000u
  ));
  free(child_path);
  free(child_stem);
  assert(keiko_windows_update_remove_tree(paths->root, GetTickCount64() + 10000u));
  free(paths);
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

static const char *test_krp_string(
    const unsigned char **cursor,
    size_t *remaining
) {
  uint32_t length;
  const char *value;
  assert(*remaining >= 4u);
  length = keiko_khp_read_u32(*cursor);
  *cursor += 4u;
  *remaining -= 4u;
  assert((size_t)length < *remaining);
  value = (const char *)*cursor;
  assert((*cursor)[length] == 0);
  *cursor += (size_t)length + 1u;
  *remaining -= (size_t)length + 1u;
  return value;
}

static void test_supervisor_packet_is_unchanged_krp1(void) {
  keiko_coordinator_context context;
  unsigned char *packet = NULL;
  const unsigned char *cursor;
  size_t packet_length = 0;
  size_t remaining;
  memset(&context, 0, sizeof(context));
  context.plan.field[KEIKO_KHP_ACTIVATION_ID] =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  context.plan.field[KEIKO_KHP_MANAGED_ROOT] = "C:\\Keiko";
  context.state_dir_utf8 = "C:\\KeikoState";
  assert(keiko_coordinator_windows_launch_packet(
      &context,
      "C:\\Keiko\\Keiko.exe",
      0,
      &packet,
      &packet_length
  ));
  assert(packet_length >= KEIKO_COORDINATOR_KRP_HEADER_BYTES + 4u);
  assert(memcmp(packet, "KRP1", 4u) == 0);
  assert(keiko_khp_read_u16(packet + 4u) == 1u);
  assert(keiko_khp_read_u16(packet + 6u) == 1u);
  assert(keiko_khp_read_u32(packet + 8u) ==
         packet_length - KEIKO_COORDINATOR_KRP_HEADER_BYTES);
  cursor = packet + KEIKO_COORDINATOR_KRP_HEADER_BYTES;
  remaining = packet_length - KEIKO_COORDINATOR_KRP_HEADER_BYTES;
  assert(keiko_khp_read_u16(cursor) == 2u);
  assert(keiko_khp_read_u16(cursor + 2u) == 1u);
  cursor += 4u;
  remaining -= 4u;
  assert(strcmp(test_krp_string(&cursor, &remaining),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") == 0);
  assert(strcmp(test_krp_string(&cursor, &remaining), "C:\\Keiko\\Keiko.exe") == 0);
  assert(strcmp(test_krp_string(&cursor, &remaining), "C:\\Keiko") == 0);
  assert(strcmp(test_krp_string(&cursor, &remaining), "--resume-update") == 0);
  assert(strcmp(test_krp_string(&cursor, &remaining),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") == 0);
  assert(strcmp(test_krp_string(&cursor, &remaining), "KEIKO_STATE_DIR") == 0);
  assert(strcmp(test_krp_string(&cursor, &remaining), "C:\\KeikoState") == 0);
  assert(remaining == 0u);
  SecureZeroMemory(packet, packet_length);
  free(packet);
}

typedef struct {
  HANDLE pipe;
  unsigned char *content;
  size_t length;
} test_pipe_reader;

static DWORD WINAPI test_read_pipe_thread(LPVOID opaque) {
  test_pipe_reader *reader = (test_pipe_reader *)opaque;
  size_t offset = 0;
  while (offset < reader->length) {
    DWORD read_bytes = 0;
    DWORD remaining = reader->length - offset > MAXDWORD
                          ? MAXDWORD
                          : (DWORD)(reader->length - offset);
    if (!ReadFile(
            reader->pipe,
            reader->content + offset,
            remaining,
            &read_bytes,
            NULL
        ) || read_bytes == 0) return 0;
    offset += read_bytes;
  }
  return 1;
}

static void test_pipe_writes_are_deadline_bounded(void) {
  int descriptors[2] = {-1, -1};
  const size_t length = KEIKO_COORDINATOR_KRP_MAX_BYTES;
  unsigned char *payload = (unsigned char *)malloc(length);
  unsigned char *received = (unsigned char *)calloc(length, 1u);
  test_pipe_reader reader;
  HANDLE thread;
  HANDLE exited;
  DWORD thread_result = 0;
  DWORD available = 0;
  uint64_t started;
  assert(payload != NULL && received != NULL);
  memset(payload, 0x5a, length);
  assert(_pipe(descriptors, 4096u, _O_BINARY | _O_NOINHERIT) == 0);
  reader.pipe = (HANDLE)_get_osfhandle(descriptors[0]);
  reader.content = received;
  reader.length = length;
  thread = CreateThread(NULL, 0, test_read_pipe_thread, &reader, 0, NULL);
  assert(thread != NULL);
  assert(keiko_coordinator_windows_write_exact_fd(
      descriptors[1],
      payload,
      length,
      GetTickCount64() + 10000u,
      NULL
  ));
  assert(WaitForSingleObject(thread, 10000u) == WAIT_OBJECT_0);
  assert(GetExitCodeThread(thread, &thread_result) && thread_result == 1u);
  assert(memcmp(payload, received, length) == 0);
  assert(CloseHandle(thread));
  keiko_coordinator_windows_close_descriptors(descriptors, 2u);

  assert(_pipe(descriptors, 4096u, _O_BINARY | _O_NOINHERIT) == 0);
  started = GetTickCount64();
  assert(!keiko_coordinator_windows_write_exact_fd(
      descriptors[1],
      payload,
      length,
      started + 100u,
      NULL
  ));
  assert(GetTickCount64() - started < 3000u);
  keiko_coordinator_windows_close_descriptors(descriptors, 2u);

  assert(_pipe(descriptors, 4096u, _O_BINARY | _O_NOINHERIT) == 0);
  exited = CreateEventW(NULL, TRUE, TRUE, NULL);
  assert(exited != NULL);
  assert(!keiko_coordinator_windows_write_exact_fd(
      descriptors[1],
      payload,
      length,
      GetTickCount64() + 10000u,
      exited
  ));
  assert(PeekNamedPipe(
      (HANDLE)_get_osfhandle(descriptors[0]),
      NULL,
      0,
      NULL,
      &available,
      NULL
  ));
  assert(available == 0u);
  assert(CloseHandle(exited));
  keiko_coordinator_windows_close_descriptors(descriptors, 2u);

  assert(_pipe(descriptors, 4096u, _O_BINARY | _O_NOINHERIT) == 0);
  assert(!keiko_coordinator_windows_write_exact_fd(
      descriptors[1],
      payload,
      length,
      GetTickCount64() - 1u,
      NULL
  ));
  assert(PeekNamedPipe(
      (HANDLE)_get_osfhandle(descriptors[0]),
      NULL,
      0,
      NULL,
      &available,
      NULL
  ));
  assert(available == 0u);
  keiko_coordinator_windows_close_descriptors(descriptors, 2u);
  SecureZeroMemory(received, length);
  SecureZeroMemory(payload, length);
  free(received);
  free(payload);
}

int wmain(void) {
  test_coordinator_pins_local_managed_root();
  test_directory_owner_policy();
  test_copy_walk_budget_is_bounded();
  test_recovery_runtime_and_lock_binding();
  test_shared_recovery_control_parser();
  test_supervisor_packet_is_unchanged_krp1();
  test_pipe_writes_are_deadline_bounded();
  test_plan_paths_bind_exact_generation_names();
  test_generation_publish_and_file_replace();
  test_productive_file_cutovers_flush_and_recover();
  test_windows_cutover_checkpoints_are_recoverable();
  test_capsule_and_receipt_junctions_are_refused();
  return 0;
}
