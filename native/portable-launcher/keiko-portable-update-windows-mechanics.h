#ifndef KEIKO_PORTABLE_UPDATE_WINDOWS_MECHANICS_H
#define KEIKO_PORTABLE_UPDATE_WINDOWS_MECHANICS_H

#if !defined(_WIN32)
#error "keiko-portable-update-windows-mechanics.h requires Win32"
#endif

#include "keiko-portable-tree-hash.h"
#include "keiko-portable-windows-atomic-replace.h"

#include <windows.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define KEIKO_WINDOWS_UPDATE_PATH_CAP 32768u
#define KEIKO_WINDOWS_UPDATE_COPY_BUFFER (64u * 1024u)
#define KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES (64u * 1024u * 1024u)

static inline wchar_t *keiko_windows_update_path_join(
    const wchar_t *base,
    const wchar_t *suffix
) {
  size_t base_length;
  size_t suffix_length;
  wchar_t *result;
  if (base == NULL || suffix == NULL) return NULL;
  base_length = wcslen(base);
  suffix_length = wcslen(suffix);
  if (base_length >= KEIKO_WINDOWS_UPDATE_PATH_CAP ||
      suffix_length > KEIKO_WINDOWS_UPDATE_PATH_CAP - base_length - 1u ||
      base_length + suffix_length > (SIZE_MAX / sizeof(wchar_t)) - 1u) return NULL;
  result = (wchar_t *)malloc((base_length + suffix_length + 1u) * sizeof(wchar_t));
  if (result == NULL) return NULL;
  memcpy(result, base, base_length * sizeof(wchar_t));
  memcpy(
      result + base_length,
      suffix,
      (suffix_length + 1u) * sizeof(wchar_t)
  );
  return result;
}

static int keiko_windows_update_handle_hash(
    HANDLE file,
    uint64_t deadline_ms,
    char output[65]
) {
  keiko_windows_atomic_file_fact before;
  keiko_windows_atomic_file_fact after;
  keiko_sha256 hash;
  unsigned char digest[32];
  unsigned char *buffer = NULL;
  uint64_t total = 0;
  int initialized = 0;
  int result = 0;
  if (!keiko_windows_atomic_query_fact(file, &before) || before.standard.Directory ||
      before.standard.EndOfFile.QuadPart < 0 ||
      (uint64_t)before.standard.EndOfFile.QuadPart > KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES ||
      !keiko_sha256_init(&hash)) return 0;
  initialized = 1;
  buffer = (unsigned char *)malloc(KEIKO_WINDOWS_UPDATE_COPY_BUFFER);
  if (buffer == NULL) goto cleanup;
  for (;;) {
    DWORD count = 0;
    if (GetTickCount64() > deadline_ms ||
        !ReadFile(file, buffer, KEIKO_WINDOWS_UPDATE_COPY_BUFFER, &count, NULL)) goto cleanup;
    if (count == 0) break;
    total += count;
    if (total > (uint64_t)before.standard.EndOfFile.QuadPart ||
        !keiko_sha256_update(&hash, buffer, count)) goto cleanup;
  }
  if (total != (uint64_t)before.standard.EndOfFile.QuadPart ||
      !keiko_windows_atomic_query_fact(file, &after) ||
      !keiko_windows_atomic_same_file(&before, &after) ||
      !keiko_sha256_final(&hash, digest)) goto cleanup;
  initialized = 0;
  keiko_sha256_hex(digest, output);
  SecureZeroMemory(digest, sizeof(digest));
  result = 1;
cleanup:
  if (initialized) keiko_sha256_clear(&hash);
  if (buffer != NULL) {
    SecureZeroMemory(buffer, KEIKO_WINDOWS_UPDATE_COPY_BUFFER);
    free(buffer);
  }
  return result;
}

static inline int keiko_windows_update_file_digest_matches(
    const wchar_t *path,
    const char *expected,
    uint64_t deadline_ms
) {
  HANDLE file = keiko_windows_atomic_open_regular(
      path,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  char actual[65];
  int result = file != INVALID_HANDLE_VALUE && file != NULL &&
               keiko_windows_update_handle_hash(file, deadline_ms, actual) &&
               strcmp(actual, expected) == 0;
  if (file != INVALID_HANDLE_VALUE && file != NULL) CloseHandle(file);
  return result;
}

static int keiko_windows_update_copy_handle(
    HANDLE source,
    const wchar_t *destination_path,
    uint64_t maximum_bytes,
    uint64_t *total_bytes,
    uint64_t deadline_ms
) {
  HANDLE destination = INVALID_HANDLE_VALUE;
  keiko_windows_atomic_file_fact source_before;
  keiko_windows_atomic_file_fact source_after;
  keiko_windows_atomic_file_fact destination_fact;
  unsigned char *buffer = NULL;
  uint64_t total = 0;
  int destination_created = 0;
  int result = 0;
  if (!keiko_windows_atomic_query_fact(source, &source_before) ||
      source_before.standard.Directory || source_before.standard.EndOfFile.QuadPart < 0 ||
      (uint64_t)source_before.standard.EndOfFile.QuadPart > maximum_bytes ||
      (total_bytes != NULL &&
       *total_bytes > KEIKO_TREE_MAX_BYTES -
           (uint64_t)source_before.standard.EndOfFile.QuadPart)) return 0;
  if (total_bytes != NULL)
    *total_bytes += (uint64_t)source_before.standard.EndOfFile.QuadPart;
  destination = CreateFileW(
      destination_path,
      GENERIC_READ | GENERIC_WRITE,
      0,
      NULL,
      CREATE_NEW,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
      NULL
  );
  if (destination == INVALID_HANDLE_VALUE || destination == NULL) goto cleanup;
  destination_created = 1;
  if (!keiko_windows_atomic_query_fact(destination, &destination_fact) ||
      destination_fact.standard.Directory || destination_fact.standard.NumberOfLinks != 1) {
    goto cleanup;
  }
  buffer = (unsigned char *)malloc(KEIKO_WINDOWS_UPDATE_COPY_BUFFER);
  if (buffer == NULL) goto cleanup;
  for (;;) {
    DWORD read_bytes = 0;
    DWORD written = 0;
    if (GetTickCount64() > deadline_ms ||
        !ReadFile(source, buffer, KEIKO_WINDOWS_UPDATE_COPY_BUFFER, &read_bytes, NULL)) {
      goto cleanup;
    }
    if (read_bytes == 0) break;
    if (!WriteFile(destination, buffer, read_bytes, &written, NULL) || written != read_bytes) {
      goto cleanup;
    }
    total += read_bytes;
  }
  if (total != (uint64_t)source_before.standard.EndOfFile.QuadPart ||
      !FlushFileBuffers(destination) ||
      !keiko_windows_atomic_query_fact(source, &source_after) ||
      !keiko_windows_atomic_same_file(&source_before, &source_after)) goto cleanup;
  result = 1;
cleanup:
  if (buffer != NULL) {
    SecureZeroMemory(buffer, KEIKO_WINDOWS_UPDATE_COPY_BUFFER);
    free(buffer);
  }
  if (destination != INVALID_HANDLE_VALUE && destination != NULL) CloseHandle(destination);
  if (!result && destination_created) (void)DeleteFileW(destination_path);
  return result;
}

static int keiko_windows_update_copy_file(
    const wchar_t *source_path,
    const wchar_t *destination_path,
    uint64_t maximum_bytes,
    uint64_t deadline_ms
) {
  HANDLE source = keiko_windows_atomic_open_regular(
      source_path,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  int result = source != INVALID_HANDLE_VALUE && source != NULL &&
               keiko_windows_update_copy_handle(
                   source,
                   destination_path,
                   maximum_bytes,
                   NULL,
                   deadline_ms
               );
  if (source != INVALID_HANDLE_VALUE && source != NULL) CloseHandle(source);
  return result;
}

static inline int keiko_windows_update_replace_file(
    const wchar_t *snapshot_path,
    const wchar_t *parent_path,
    const wchar_t *temporary_path,
    const wchar_t *destination_path,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  HANDLE flush_handle = INVALID_HANDLE_VALUE;
  HANDLE published = INVALID_HANDLE_VALUE;
  keiko_windows_atomic_file_fact flushed_fact;
  keiko_windows_atomic_file_fact published_fact;
  char published_sha256[65];
  int temporary_created = 0;
  int result = 0;
  if (!keiko_windows_atomic_destination_absent(temporary_path) ||
      !keiko_windows_update_file_digest_matches(
          snapshot_path,
          expected_sha256,
          deadline_ms
      )) goto cleanup;
  if (!keiko_windows_update_copy_file(
          snapshot_path,
          temporary_path,
          KEIKO_WINDOWS_UPDATE_MAX_FILE_BYTES,
          deadline_ms
      )) goto cleanup;
  temporary_created = 1;
  if (
      !keiko_windows_update_file_digest_matches(
          temporary_path,
          expected_sha256,
          deadline_ms
      ) ||
      !keiko_windows_atomic_replace_existing(
          parent_path,
          temporary_path,
          destination_path,
          deadline_ms,
          &flush_handle
      ) || flush_handle == INVALID_HANDLE_VALUE || flush_handle == NULL ||
      !keiko_windows_atomic_query_fact(flush_handle, &flushed_fact)) goto cleanup;
  CloseHandle(flush_handle);
  flush_handle = INVALID_HANDLE_VALUE;
  published = keiko_windows_atomic_open_regular(
      destination_path,
      GENERIC_READ,
      FILE_SHARE_READ
  );
  if (published == INVALID_HANDLE_VALUE || published == NULL ||
      !keiko_windows_atomic_query_fact(published, &published_fact) ||
      !keiko_windows_atomic_same_file(&flushed_fact, &published_fact) ||
      flushed_fact.standard.EndOfFile.QuadPart != published_fact.standard.EndOfFile.QuadPart ||
      !keiko_windows_update_handle_hash(published, deadline_ms, published_sha256) ||
      strcmp(published_sha256, expected_sha256) != 0) goto cleanup;
  result = 1;
cleanup:
  if (flush_handle != INVALID_HANDLE_VALUE && flush_handle != NULL) CloseHandle(flush_handle);
  if (published != INVALID_HANDLE_VALUE && published != NULL) CloseHandle(published);
  if (!result && temporary_created) {
    DWORD attributes = GetFileAttributesW(temporary_path);
    if (attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0) {
      (void)DeleteFileW(temporary_path);
    }
  }
  return result;
}

static int keiko_windows_update_copy_directory_contents(
    HANDLE source,
    HANDLE destination,
    const char *relative,
    keiko_tree_walk_budget *budget,
    uint64_t *total_bytes,
    uint64_t deadline_ms,
    unsigned int depth
) {
  WIN32_FIND_DATAW entry;
  HANDLE find = INVALID_HANDLE_VALUE;
  DWORD error;
  keiko_tree_windows_identity source_before;
  keiko_tree_windows_identity source_after;
  int result = 0;
  if (relative == NULL || budget == NULL || total_bytes == NULL ||
      depth > KEIKO_TREE_MAX_DEPTH || GetTickCount64() > deadline_ms ||
      !keiko_tree_windows_read_identity(source, 1, &source_before)) return 0;
  find = keiko_tree_windows_find_first(source, &entry, &error);
  if (find == INVALID_HANDLE_VALUE) return error == ERROR_FILE_NOT_FOUND;
  for (;;) {
    size_t length = wcslen(entry.cFileName);
    int dot = length == 1u && entry.cFileName[0] == L'.';
    int dotdot = length == 2u && entry.cFileName[0] == L'.' && entry.cFileName[1] == L'.';
    if (!dot && !dotdot) {
      char *component = NULL;
      char *child_name = NULL;
      int directory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      HANDLE source_child = keiko_tree_windows_open_child(source, entry.cFileName, directory);
      wchar_t *destination_path = (wchar_t *)malloc(
          KEIKO_TREE_WINDOWS_PATH_CAP * sizeof(wchar_t)
      );
      HANDLE destination_child = INVALID_HANDLE_VALUE;
      int copied = 0;
      if (!keiko_tree_windows_component_utf8(entry.cFileName, length, &component) ||
          !keiko_tree_windows_join_relative(&child_name, relative, component) ||
          !keiko_tree_record_entry(budget, child_name) ||
          source_child == INVALID_HANDLE_VALUE || source_child == NULL ||
          destination_path == NULL ||
          !keiko_tree_windows_child_path(destination_path, destination, entry.cFileName)) {
        if (source_child != INVALID_HANDLE_VALUE && source_child != NULL)
          CloseHandle(source_child);
        free(destination_path);
        free(child_name);
        free(component);
        goto cleanup;
      }
      if (directory) {
        copied = CreateDirectoryW(destination_path, NULL) != 0;
        if (copied) {
          destination_child = keiko_windows_atomic_open_directory(
              destination_path,
              FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
              FILE_SHARE_READ | FILE_SHARE_WRITE
          );
          copied = destination_child != INVALID_HANDLE_VALUE && destination_child != NULL &&
                   keiko_windows_update_copy_directory_contents(
                       source_child,
                       destination_child,
                       child_name,
                       budget,
                       total_bytes,
                       deadline_ms,
                       depth + 1u
                   );
        }
      } else {
        copied = keiko_windows_update_copy_handle(
            source_child,
            destination_path,
            KEIKO_TREE_MAX_FILE_BYTES,
            total_bytes,
            deadline_ms
        );
      }
      if (destination_child != INVALID_HANDLE_VALUE && destination_child != NULL)
        CloseHandle(destination_child);
      CloseHandle(source_child);
      free(destination_path);
      free(child_name);
      free(component);
      if (!copied) goto cleanup;
    }
    if (!FindNextFileW(find, &entry)) break;
  }
  if (GetLastError() != ERROR_NO_MORE_FILES ||
      !keiko_tree_windows_read_identity(source, 1, &source_after) ||
      !keiko_tree_windows_same_identity(&source_before, &source_after)) goto cleanup;
  result = 1;
cleanup:
  FindClose(find);
  return result;
}

static int keiko_windows_update_remove_directory_contents(
    HANDLE directory,
    uint64_t deadline_ms,
    unsigned int depth
) {
  WIN32_FIND_DATAW entry;
  HANDLE find = INVALID_HANDLE_VALUE;
  DWORD error;
  int result = 0;
  if (depth > KEIKO_TREE_MAX_DEPTH || GetTickCount64() > deadline_ms) return 0;
  find = keiko_tree_windows_find_first(directory, &entry, &error);
  if (find == INVALID_HANDLE_VALUE) return error == ERROR_FILE_NOT_FOUND;
  for (;;) {
    size_t length = wcslen(entry.cFileName);
    int dot = length == 1u && entry.cFileName[0] == L'.';
    int dotdot = length == 2u && entry.cFileName[0] == L'.' && entry.cFileName[1] == L'.';
    if (!dot && !dotdot) {
      int child_is_directory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      HANDLE child = keiko_tree_windows_open_child(
          directory,
          entry.cFileName,
          child_is_directory
      );
      wchar_t *path = (wchar_t *)malloc(KEIKO_TREE_WINDOWS_PATH_CAP * sizeof(wchar_t));
      int removed = 0;
      if (child == INVALID_HANDLE_VALUE || child == NULL || path == NULL ||
          !keiko_tree_windows_child_path(path, directory, entry.cFileName)) {
        if (child != INVALID_HANDLE_VALUE && child != NULL) CloseHandle(child);
        free(path);
        goto cleanup;
      }
      if (child_is_directory) {
        removed = keiko_windows_update_remove_directory_contents(
            child,
            deadline_ms,
            depth + 1u
        );
        CloseHandle(child);
        if (removed) removed = RemoveDirectoryW(path) != 0;
      } else {
        CloseHandle(child);
        removed = DeleteFileW(path) != 0;
      }
      free(path);
      if (!removed) goto cleanup;
    }
    if (!FindNextFileW(find, &entry)) break;
  }
  result = GetLastError() == ERROR_NO_MORE_FILES;
cleanup:
  FindClose(find);
  return result;
}

static inline int keiko_windows_update_remove_tree(
    const wchar_t *path,
    uint64_t deadline_ms
) {
  HANDLE directory;
  DWORD attributes = GetFileAttributesW(path);
  DWORD error;
  int result;
  if (attributes == INVALID_FILE_ATTRIBUTES) {
    error = GetLastError();
    return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
  }
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return 0;
  directory = keiko_windows_atomic_open_directory(
      path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE
  );
  if (directory == INVALID_HANDLE_VALUE || directory == NULL) return 0;
  result = keiko_windows_update_remove_directory_contents(directory, deadline_ms, 0u);
  CloseHandle(directory);
  return result && RemoveDirectoryW(path) != 0;
}

static int keiko_windows_update_tree_hash(
    HANDLE root,
    uint64_t deadline_ms,
    char output[65],
    keiko_tree_windows_pins *pins
) {
  return keiko_tree_hash_windows_handle_pinned(root, deadline_ms, output, pins);
}

static inline int keiko_windows_update_tree_digest_matches(
    const wchar_t *path,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  HANDLE root = keiko_windows_atomic_open_directory(
      path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ
  );
  keiko_tree_windows_pins pins = {0};
  char digest[65];
  int result = root != INVALID_HANDLE_VALUE && root != NULL &&
               keiko_windows_update_tree_hash(root, deadline_ms, digest, &pins) &&
               strcmp(digest, expected_sha256) == 0;
  keiko_tree_windows_pins_clear(&pins);
  if (root != INVALID_HANDLE_VALUE && root != NULL) CloseHandle(root);
  return result;
}

static inline int keiko_windows_update_copy_publish_generation(
    const wchar_t *source_path,
    const wchar_t *generations_path,
    const wchar_t *incoming_path,
    const wchar_t *published_path,
    const char *expected_sha256,
    uint64_t deadline_ms
) {
  HANDLE source = INVALID_HANDLE_VALUE;
  HANDLE incoming = INVALID_HANDLE_VALUE;
  keiko_tree_windows_pins source_pins = {0};
  keiko_tree_windows_pins second_pins = {0};
  keiko_tree_windows_pins incoming_pins = {0};
  keiko_tree_windows_pins published_pins = {0};
  char source_digest[65];
  char second_source_digest[65];
  char incoming_digest[65];
  char published_digest[65];
  keiko_tree_walk_budget copy_budget = {0};
  uint64_t copy_total_bytes = 0;
  int incoming_created = 0;
  int published = 0;
  int result = 0;

  if (!keiko_windows_atomic_destination_absent(incoming_path) ||
      !keiko_windows_atomic_destination_absent(published_path)) return 0;
  source = keiko_windows_atomic_open_directory(
      source_path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | DELETE,
      FILE_SHARE_READ | FILE_SHARE_DELETE
  );
  if (source == INVALID_HANDLE_VALUE || source == NULL ||
      !keiko_windows_update_tree_hash(
          source,
          deadline_ms,
          source_digest,
          &source_pins
      ) ||
      strcmp(source_digest, expected_sha256) != 0 ||
      !CreateDirectoryW(incoming_path, NULL)) goto cleanup;
  incoming_created = 1;
  incoming = keiko_windows_atomic_open_directory(
      incoming_path,
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_DELETE
  );
  if (incoming == INVALID_HANDLE_VALUE || incoming == NULL ||
      !keiko_windows_update_copy_directory_contents(
          source,
          incoming,
          "",
          &copy_budget,
          &copy_total_bytes,
          deadline_ms,
          0u
      ) ||
      !keiko_windows_update_tree_hash(
          source,
          deadline_ms,
          second_source_digest,
          &second_pins
      ) ||
      strcmp(second_source_digest, expected_sha256) != 0 ||
      !keiko_windows_update_tree_hash(
          incoming,
          deadline_ms,
          incoming_digest,
          &incoming_pins
      ) ||
      strcmp(incoming_digest, expected_sha256) != 0) goto cleanup;
  /* The KHT1 walker deliberately denies rename sharing while it snapshots
   * descendants. Release those scan handles before the audited namespace
   * operation, then re-open and hash the published name immediately below. */
  keiko_tree_windows_pins_clear(&incoming_pins);
  keiko_tree_windows_pins_clear(&second_pins);
  keiko_tree_windows_pins_clear(&source_pins);
  CloseHandle(incoming);
  incoming = INVALID_HANDLE_VALUE;
  CloseHandle(source);
  source = INVALID_HANDLE_VALUE;
  if (!keiko_windows_atomic_publish_directory(
          generations_path,
          incoming_path,
          published_path,
          deadline_ms
      )) goto cleanup;
  published = 1;
  {
    HANDLE published_handle = keiko_windows_atomic_open_directory(
        published_path,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ
    );
    if (published_handle == INVALID_HANDLE_VALUE || published_handle == NULL ||
        !keiko_windows_update_tree_hash(
            published_handle,
            deadline_ms,
            published_digest,
            &published_pins
        ) ||
        strcmp(published_digest, expected_sha256) != 0) {
      if (published_handle != INVALID_HANDLE_VALUE && published_handle != NULL)
        CloseHandle(published_handle);
      goto cleanup;
    }
    CloseHandle(published_handle);
  }
  result = 1;
cleanup:
  keiko_tree_windows_pins_clear(&published_pins);
  keiko_tree_windows_pins_clear(&incoming_pins);
  keiko_tree_windows_pins_clear(&second_pins);
  keiko_tree_windows_pins_clear(&source_pins);
  if (incoming != INVALID_HANDLE_VALUE && incoming != NULL) CloseHandle(incoming);
  if (source != INVALID_HANDLE_VALUE && source != NULL) CloseHandle(source);
  if (!result && incoming_created && !published) {
    (void)keiko_windows_update_remove_tree(incoming_path, deadline_ms);
  }
  return result;
}

#endif
