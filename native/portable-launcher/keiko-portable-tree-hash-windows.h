#ifndef KEIKO_PORTABLE_TREE_HASH_WINDOWS_H
#define KEIKO_PORTABLE_TREE_HASH_WINDOWS_H

#include <wchar.h>
#include <windows.h>

#define KEIKO_TREE_WINDOWS_PATH_CAP 32768u

#ifndef KEIKO_TREE_WINDOWS_AFTER_FILE_PIN
#define KEIKO_TREE_WINDOWS_AFTER_FILE_PIN(name) ((void)(name))
#endif

typedef struct {
  FILE_ID_INFO id;
  FILE_STANDARD_INFO standard;
  FILE_BASIC_INFO basic;
} keiko_tree_windows_identity;

typedef struct {
  HANDLE *handles;
  size_t count;
  size_t capacity;
} keiko_tree_windows_pins;

static void keiko_tree_windows_pins_clear(keiko_tree_windows_pins *pins) {
  size_t index;
  for (index = 0; index < pins->count; ++index) CloseHandle(pins->handles[index]);
  free(pins->handles);
  memset(pins, 0, sizeof(*pins));
}

static int keiko_tree_windows_pins_add(keiko_tree_windows_pins *pins, HANDLE file) {
  if (pins->count == pins->capacity) {
    size_t next = pins->capacity == 0 ? 64u : pins->capacity * 2u;
    HANDLE *resized;
    if (next > KEIKO_TREE_MAX_ENTRIES) next = KEIKO_TREE_MAX_ENTRIES;
    if (next <= pins->count) return 0;
    resized = (HANDLE *)realloc(pins->handles, next * sizeof(HANDLE));
    if (resized == NULL) return 0;
    pins->handles = resized;
    pins->capacity = next;
  }
  pins->handles[pins->count++] = file;
  return 1;
}

static uint64_t keiko_tree_now_ms(void) {
  return (uint64_t)GetTickCount64();
}

static int keiko_tree_before_deadline(uint64_t deadline_ms) {
  return keiko_tree_now_ms() <= deadline_ms;
}

static int keiko_tree_windows_same_identity(const keiko_tree_windows_identity *left,
                                            const keiko_tree_windows_identity *right) {
  return left->id.VolumeSerialNumber == right->id.VolumeSerialNumber &&
         memcmp(left->id.FileId.Identifier, right->id.FileId.Identifier,
                sizeof(left->id.FileId.Identifier)) == 0 &&
         left->standard.NumberOfLinks == right->standard.NumberOfLinks &&
         left->standard.EndOfFile.QuadPart == right->standard.EndOfFile.QuadPart &&
         left->basic.LastWriteTime.QuadPart == right->basic.LastWriteTime.QuadPart &&
         left->basic.ChangeTime.QuadPart == right->basic.ChangeTime.QuadPart;
}

static int keiko_tree_windows_read_identity(HANDLE handle, int directory,
                                            keiko_tree_windows_identity *identity) {
  FILE_ATTRIBUTE_TAG_INFO tag;
  if (handle == INVALID_HANDLE_VALUE || GetFileType(handle) != FILE_TYPE_DISK ||
      !GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &identity->id,
                                    sizeof(identity->id)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &identity->standard,
                                    sizeof(identity->standard)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &identity->basic,
                                    sizeof(identity->basic))) return 0;
  return identity->standard.Directory == (directory != 0) &&
         (directory || (identity->standard.NumberOfLinks == 1 &&
                        identity->standard.EndOfFile.QuadPart >= 0));
}

static int keiko_tree_windows_final_path(HANDLE handle, wchar_t path[KEIKO_TREE_WINDOWS_PATH_CAP]) {
  DWORD length = GetFinalPathNameByHandleW(handle, path, KEIKO_TREE_WINDOWS_PATH_CAP,
                                           FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  return length >= 7u && length < KEIKO_TREE_WINDOWS_PATH_CAP && path[0] == L'\\' &&
         path[1] == L'\\' && path[2] == L'?' && path[3] == L'\\' && path[5] == L':' &&
         path[6] == L'\\';
}

static int keiko_tree_windows_child_path(wchar_t output[KEIKO_TREE_WINDOWS_PATH_CAP],
                                         HANDLE parent, const wchar_t *name) {
  size_t parent_length, name_length = wcslen(name);
  if (!keiko_tree_windows_final_path(parent, output)) return 0;
  parent_length = wcslen(output);
  if (name_length == 0 || parent_length > KEIKO_TREE_WINDOWS_PATH_CAP - name_length - 2u)
    return 0;
  output[parent_length] = L'\\';
  memcpy(output + parent_length + 1u, name, (name_length + 1u) * sizeof(wchar_t));
  return 1;
}

static HANDLE keiko_tree_windows_open_child(HANDLE parent, const wchar_t *name, int directory) {
  wchar_t path[KEIKO_TREE_WINDOWS_PATH_CAP];
  DWORD access = directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES : GENERIC_READ;
  DWORD flags = FILE_FLAG_OPEN_REPARSE_POINT |
                (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN);
  HANDLE child;
  keiko_tree_windows_identity identity;
  /* CreateFileW has no openat-style parent argument. The parent stays open without write/delete
   * sharing while its canonical local path is resolved; OPEN_REPARSE_POINT plus post-open identity
   * checks makes the absolute child open fail closed on redirection. */
  if (!keiko_tree_windows_child_path(path, parent, name)) return INVALID_HANDLE_VALUE;
  child = CreateFileW(path, access, FILE_SHARE_READ, NULL, OPEN_EXISTING, flags, NULL);
  if (!keiko_tree_windows_read_identity(child, directory, &identity)) {
    if (child != INVALID_HANDLE_VALUE) CloseHandle(child);
    return INVALID_HANDLE_VALUE;
  }
  return child;
}

static int keiko_tree_windows_component_utf8(const wchar_t *name, size_t length, char **output) {
  int bytes;
  size_t index;
  if (length == 0 || length > INT_MAX) return 0;
  for (index = 0; index < length; ++index)
    if (name[index] == L'/' || name[index] == L'\\' || name[index] == L'\0') return 0;
  if ((length == 1u && name[0] == L'.') ||
      (length == 2u && name[0] == L'.' && name[1] == L'.')) return 0;
  bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, (int)length,
                              NULL, 0, NULL, NULL);
  if (bytes <= 0) return 0;
  *output = (char *)malloc((size_t)bytes + 1u);
  if (*output != NULL &&
      WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, name, (int)length,
                          *output, bytes, NULL, NULL) == bytes) {
    (*output)[bytes] = '\0';
  } else {
    free(*output);
    *output = NULL;
  }
  return *output != NULL;
}

static int keiko_tree_windows_join_relative(char **output, const char *parent,
                                            const char *component) {
  size_t parent_length = strlen(parent), component_length = strlen(component), total;
  if (parent_length > SIZE_MAX - component_length - 2u) return 0;
  total = parent_length + (parent_length == 0 ? 0u : 1u) + component_length;
  *output = (char *)malloc(total + 1u);
  if (*output == NULL) return 0;
  if (parent_length == 0) memcpy(*output, component, component_length + 1u);
  else {
    memcpy(*output, parent, parent_length);
    (*output)[parent_length] = '/';
    memcpy(*output + parent_length + 1u, component, component_length + 1u);
  }
  return 1;
}

static HANDLE keiko_tree_windows_find_first(HANDLE directory, WIN32_FIND_DATAW *entry,
                                            DWORD *error) {
  wchar_t *pattern = (wchar_t *)malloc(KEIKO_TREE_WINDOWS_PATH_CAP * sizeof(wchar_t));
  HANDLE find = INVALID_HANDLE_VALUE;
  *error = ERROR_NOT_ENOUGH_MEMORY;
  if (pattern != NULL && keiko_tree_windows_final_path(directory, pattern)) {
    size_t length = wcslen(pattern);
    *error = ERROR_INVALID_NAME;
    if (length <= KEIKO_TREE_WINDOWS_PATH_CAP - 3u) {
      pattern[length] = L'\\';
      pattern[length + 1u] = L'*';
      pattern[length + 2u] = L'\0';
      find = FindFirstFileW(pattern, entry);
      *error = find == INVALID_HANDLE_VALUE ? GetLastError() : ERROR_SUCCESS;
    }
  }
  free(pattern);
  return find;
}

static int keiko_tree_windows_collect_directory(HANDLE directory, const char *relative,
                                                keiko_tree_names *files,
                                                keiko_tree_walk_budget *budget,
                                                unsigned int depth, uint64_t deadline_ms,
                                                keiko_tree_windows_pins *pins) {
  WIN32_FIND_DATAW entry;
  HANDLE find = INVALID_HANDLE_VALUE;
  DWORD find_error;
  int result = 0;
  if (!keiko_tree_before_deadline(deadline_ms) || depth > KEIKO_TREE_MAX_DEPTH) return 0;
  find = keiko_tree_windows_find_first(directory, &entry, &find_error);
  if (find == INVALID_HANDLE_VALUE) return find_error == ERROR_FILE_NOT_FOUND;
  for (;;) {
    size_t wide_length = wcslen(entry.cFileName);
    char *component = NULL, *child_name = NULL;
    HANDLE child = INVALID_HANDLE_VALUE;
    int is_directory;
    if (!keiko_tree_before_deadline(deadline_ms)) goto cleanup;
    if (!((wide_length == 1u && entry.cFileName[0] == L'.') ||
          (wide_length == 2u && entry.cFileName[0] == L'.' && entry.cFileName[1] == L'.'))) {
      if (!keiko_tree_windows_component_utf8(entry.cFileName, wide_length, &component) ||
          !keiko_tree_windows_join_relative(&child_name, relative, component) ||
          !keiko_tree_record_entry(budget, child_name)) goto entry_cleanup;
      is_directory = (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      child = keiko_tree_windows_open_child(directory, entry.cFileName, is_directory);
      if (child == INVALID_HANDLE_VALUE) goto entry_cleanup;
      if (is_directory) {
        HANDLE retained = child;
        /* Retain every directory from the first traversal so a hashed file's parent chain cannot
         * be renamed and replaced later in the same pass. File handles are retained when read. */
        if (pins != NULL) {
          if (!keiko_tree_windows_pins_add(pins, child)) goto entry_cleanup;
          child = INVALID_HANDLE_VALUE;
        }
        if (!keiko_tree_windows_collect_directory(retained, child_name, files, budget,
                                                  depth + 1u, deadline_ms, pins))
          goto entry_cleanup;
      } else if (!keiko_tree_names_add(files, child_name)) goto entry_cleanup;
    }
    if (child != INVALID_HANDLE_VALUE) CloseHandle(child);
    free(child_name);
    free(component);
    if (!FindNextFileW(find, &entry)) break;
    continue;
entry_cleanup:
    if (child != INVALID_HANDLE_VALUE) CloseHandle(child);
    free(child_name);
    free(component);
    goto cleanup;
  }
  if (GetLastError() == ERROR_NO_MORE_FILES) result = 1;
cleanup:
  FindClose(find);
  return result;
}

static int keiko_tree_windows_collect(HANDLE root, keiko_tree_names *files,
                                      uint64_t deadline_ms,
                                      keiko_tree_windows_pins *pins) {
  keiko_tree_walk_budget budget = {0};
  keiko_tree_windows_identity identity;
  memset(files, 0, sizeof(*files));
  if (!keiko_tree_windows_read_identity(root, 1, &identity) ||
      !keiko_tree_windows_collect_directory(root, "", files, &budget, 0, deadline_ms,
                                            pins)) {
    keiko_tree_names_clear(files);
    return 0;
  }
  qsort(files->names, files->count, sizeof(char *), keiko_tree_name_compare);
  return 1;
}

static int keiko_tree_windows_utf8_component(const char *value, size_t length,
                                             wchar_t **output) {
  int characters;
  if (length == 0 || length > INT_MAX) return 0;
  characters = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, (int)length, NULL, 0);
  if (characters <= 0) return 0;
  *output = (wchar_t *)malloc(((size_t)characters + 1u) * sizeof(wchar_t));
  if (*output == NULL) return 0;
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value, (int)length, *output,
                          characters) != characters) {
    free(*output);
    *output = NULL;
    return 0;
  }
  (*output)[characters] = L'\0';
  return 1;
}

static HANDLE keiko_tree_windows_open_relative_file(HANDLE root, const char *relative) {
  HANDLE chain[KEIKO_TREE_MAX_DEPTH + 2u];
  const char *cursor = relative, *separator;
  size_t count = 0, index;
  HANDLE result = INVALID_HANDLE_VALUE;
  chain[count++] = root;
  while (*cursor != '\0' && count < KEIKO_TREE_MAX_DEPTH + 2u) {
    wchar_t *component = NULL;
    size_t length;
    separator = strchr(cursor, '/');
    length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
    if (!keiko_tree_windows_utf8_component(cursor, length, &component)) goto cleanup;
    chain[count] = keiko_tree_windows_open_child(chain[count - 1u], component,
                                                 separator != NULL);
    free(component);
    if (chain[count] == INVALID_HANDLE_VALUE) goto cleanup;
    count += 1u;
    if (separator == NULL) {
      result = chain[count - 1u];
      break;
    }
    cursor = separator + 1u;
  }
cleanup:
  for (index = 1u; index + 1u < count; ++index) CloseHandle(chain[index]);
  if (result == INVALID_HANDLE_VALUE && count > 1u) CloseHandle(chain[count - 1u]);
  return result;
}

static int keiko_tree_windows_digest_file(HANDLE root, const char *name, keiko_sha256 *tree,
                                          uint64_t *total_bytes, uint64_t deadline_ms,
                                          keiko_tree_windows_pins *pins) {
  HANDLE file = keiko_tree_windows_open_relative_file(root, name), current = INVALID_HANDLE_VALUE;
  keiko_tree_windows_identity before, after, current_identity;
  keiko_sha256 hash;
  unsigned char digest[32], buffer[64u * 1024u];
  uint64_t bytes = 0;
  int result = 0;
  if (!keiko_tree_windows_read_identity(file, 0, &before) ||
      (uint64_t)before.standard.EndOfFile.QuadPart > KEIKO_TREE_MAX_FILE_BYTES ||
      !keiko_sha256_init(&hash)) goto cleanup;
  for (;;) {
    DWORD read_bytes = 0;
    if (!keiko_tree_before_deadline(deadline_ms) ||
        !ReadFile(file, buffer, sizeof(buffer), &read_bytes, NULL)) goto hash_cleanup;
    if (read_bytes == 0) break;
    bytes += read_bytes;
    if (bytes > (uint64_t)before.standard.EndOfFile.QuadPart ||
        !keiko_sha256_update(&hash, buffer, read_bytes)) goto hash_cleanup;
  }
  if (!keiko_tree_windows_read_identity(file, 0, &after) ||
      !keiko_tree_windows_same_identity(&before, &after) ||
      bytes != (uint64_t)before.standard.EndOfFile.QuadPart) goto hash_cleanup;
  current = keiko_tree_windows_open_relative_file(root, name);
  if (!keiko_tree_windows_read_identity(current, 0, &current_identity) ||
      !keiko_tree_windows_same_identity(&before, &current_identity) ||
      *total_bytes > KEIKO_TREE_MAX_BYTES - bytes || !keiko_sha256_final(&hash, digest) ||
      !keiko_sha256_update(tree, digest, sizeof(digest)) ||
      (pins != NULL && !keiko_tree_windows_pins_add(pins, file))) goto hash_cleanup;
  *total_bytes += bytes;
  if (pins != NULL) {
    file = INVALID_HANDLE_VALUE;
    KEIKO_TREE_WINDOWS_AFTER_FILE_PIN(name);
  }
  SecureZeroMemory(digest, sizeof(digest));
  result = 1;
  goto cleanup;
hash_cleanup:
  keiko_sha256_clear(&hash);
cleanup:
  if (current != INVALID_HANDLE_VALUE) CloseHandle(current);
  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  return result;
}

static int keiko_tree_hash_windows_handle_pinned(HANDLE root, uint64_t deadline_ms,
                                                 char output[65],
                                                 keiko_tree_windows_pins *pins) {
  keiko_tree_names before = {0}, after = {0};
  keiko_sha256 tree;
  unsigned char digest[32], count_bytes[4], length_bytes[4];
  uint64_t total_bytes = 0;
  size_t index;
  int result = 0;
  if (pins == NULL || !keiko_tree_windows_collect(root, &before, deadline_ms, pins) ||
      !keiko_sha256_init(&tree)) goto cleanup;
  if (!keiko_sha256_update(&tree, "KHT1", 4u)) goto hash_cleanup;
  keiko_tree_u32le(count_bytes, (uint32_t)before.count);
  if (!keiko_sha256_update(&tree, count_bytes, sizeof(count_bytes))) goto hash_cleanup;
  for (index = 0; index < before.count; ++index) {
    size_t length = strlen(before.names[index]);
    if (length > UINT32_MAX) goto hash_cleanup;
    keiko_tree_u32le(length_bytes, (uint32_t)length);
    if (!keiko_sha256_update(&tree, length_bytes, sizeof(length_bytes)) ||
        !keiko_sha256_update(&tree, before.names[index], length) ||
        !keiko_tree_windows_digest_file(root, before.names[index], &tree, &total_bytes,
                                        deadline_ms, pins)) goto hash_cleanup;
  }
  if (!keiko_tree_windows_collect(root, &after, deadline_ms, NULL) ||
      !keiko_tree_same_names(&before, &after) || !keiko_sha256_final(&tree, digest))
    goto hash_cleanup;
  keiko_sha256_hex(digest, output);
  SecureZeroMemory(digest, sizeof(digest));
  result = 1;
  goto cleanup;
hash_cleanup:
  keiko_sha256_clear(&tree);
cleanup:
  if (!result && pins != NULL) keiko_tree_windows_pins_clear(pins);
  keiko_tree_names_clear(&before);
  keiko_tree_names_clear(&after);
  return result;
}

#if defined(KEIKO_TREE_WINDOWS_PATH_API)
static int keiko_tree_hash_windows(const wchar_t *root_path, uint64_t deadline_ms,
                                   char output[65]) {
  HANDLE root = CreateFileW(root_path, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                            FILE_SHARE_READ, NULL, OPEN_EXISTING,
                            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  keiko_tree_windows_pins pins = {0};
  int result = root != INVALID_HANDLE_VALUE &&
               keiko_tree_hash_windows_handle_pinned(root, deadline_ms, output, &pins);
  keiko_tree_windows_pins_clear(&pins);
  if (root != INVALID_HANDLE_VALUE) CloseHandle(root);
  return result;
}
#endif

#endif
