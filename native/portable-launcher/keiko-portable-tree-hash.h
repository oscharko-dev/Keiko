#ifndef KEIKO_PORTABLE_TREE_HASH_H
#define KEIKO_PORTABLE_TREE_HASH_H

#include "keiko-portable-sha256.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define KEIKO_TREE_MAX_ENTRIES 60000u
#define KEIKO_TREE_MAX_PATH_BYTES (16u * 1024u * 1024u)
#define KEIKO_TREE_MAX_FILE_BYTES (256u * 1024u * 1024u)
#define KEIKO_TREE_MAX_BYTES (UINT64_C(2) * 1024u * 1024u * 1024u)
#define KEIKO_TREE_MAX_DEPTH 128u

typedef struct {
  char **names;
  size_t count;
  size_t capacity;
  size_t path_bytes;
} keiko_tree_names;

static void keiko_tree_names_clear(keiko_tree_names *names) {
  size_t index;
  for (index = 0; index < names->count; ++index) free(names->names[index]);
  free(names->names);
  memset(names, 0, sizeof(*names));
}

static int keiko_tree_names_add(keiko_tree_names *names, const char *value) {
  size_t length = strlen(value);
  char *copy;
  if (names->count >= KEIKO_TREE_MAX_ENTRIES ||
      length > KEIKO_TREE_MAX_PATH_BYTES - names->path_bytes) return 0;
  if (names->count == names->capacity) {
    size_t next = names->capacity == 0 ? 64u : names->capacity * 2u;
    char **resized;
    if (next > KEIKO_TREE_MAX_ENTRIES) next = KEIKO_TREE_MAX_ENTRIES;
    resized = (char **)realloc(names->names, next * sizeof(char *));
    if (resized == NULL) return 0;
    names->names = resized;
    names->capacity = next;
  }
  copy = (char *)malloc(length + 1u);
  if (copy == NULL) return 0;
  memcpy(copy, value, length + 1u);
  names->names[names->count++] = copy;
  names->path_bytes += length;
  return 1;
}

static int keiko_tree_name_compare(const void *left, const void *right) {
  const unsigned char *a = *(const unsigned char *const *)left;
  const unsigned char *b = *(const unsigned char *const *)right;
  while (*a != 0 && *a == *b) {
    ++a;
    ++b;
  }
  return (int)*a - (int)*b;
}

static void keiko_tree_u32le(unsigned char output[4], uint32_t value) {
  output[0] = (unsigned char)value;
  output[1] = (unsigned char)(value >> 8);
  output[2] = (unsigned char)(value >> 16);
  output[3] = (unsigned char)(value >> 24);
}

typedef struct {
  size_t entries;
  size_t path_bytes;
} keiko_tree_walk_budget;

static int keiko_tree_record_entry(keiko_tree_walk_budget *budget, const char *name) {
  size_t length = strlen(name);
  if (budget->entries >= KEIKO_TREE_MAX_ENTRIES ||
      length > KEIKO_TREE_MAX_PATH_BYTES - budget->path_bytes) return 0;
  budget->entries += 1u;
  budget->path_bytes += length;
  return 1;
}

static int keiko_tree_same_names(const keiko_tree_names *left,
                                 const keiko_tree_names *right) {
  size_t index;
  if (left->count != right->count) return 0;
  for (index = 0; index < left->count; ++index)
    if (strcmp(left->names[index], right->names[index]) != 0) return 0;
  return 1;
}

#if defined(_WIN32)

#include "keiko-portable-tree-hash-windows.h"

#else

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static uint64_t keiko_tree_now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * UINT64_C(1000) + (uint64_t)value.tv_nsec / UINT64_C(1000000);
}

static int keiko_tree_before_deadline(uint64_t deadline_ms) {
  return keiko_tree_now_ms() <= deadline_ms;
}

static int keiko_tree_valid_component(const char *name) {
  return name[0] != '\0' && strcmp(name, ".") != 0 && strcmp(name, "..") != 0 &&
         strchr(name, '/') == NULL && strchr(name, '\\') == NULL;
}

static int keiko_tree_open_relative(int root, const char *relative, int final_flags) {
  char *storage, *cursor, *separator;
  int current, next;
  size_t length = strlen(relative);
  if (length == 0 || relative[0] == '/' || relative[length - 1] == '/') return -1;
  storage = (char *)malloc(length + 1u);
  if (storage == NULL) return -1;
  memcpy(storage, relative, length + 1u);
  current = dup(root);
  if (current == -1) {
    free(storage);
    return -1;
  }
  cursor = storage;
  for (;;) {
    separator = strchr(cursor, '/');
    if (separator != NULL) *separator = '\0';
    if (!keiko_tree_valid_component(cursor)) {
      close(current);
      free(storage);
      return -1;
    }
    next = openat(current, cursor,
                  separator == NULL ? final_flags | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK
                                    : O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(current);
    if (next == -1) {
      free(storage);
      return -1;
    }
    if (separator == NULL) break;
    current = next;
    cursor = separator + 1;
  }
  free(storage);
  return next;
}

static int keiko_tree_join_relative(char **output, const char *parent, const char *name) {
  size_t parent_length = strlen(parent), name_length = strlen(name), total;
  if (!keiko_tree_valid_component(name)) return 0;
  if (parent_length > SIZE_MAX - name_length - 2u) return 0;
  total = parent_length + (parent_length == 0 ? 0u : 1u) + name_length;
  *output = (char *)malloc(total + 1u);
  if (*output == NULL) return 0;
  if (parent_length == 0) memcpy(*output, name, name_length + 1u);
  else {
    memcpy(*output, parent, parent_length);
    (*output)[parent_length] = '/';
    memcpy(*output + parent_length + 1u, name, name_length + 1u);
  }
  return 1;
}

static int keiko_tree_collect_directory(int root, const char *relative,
                                        keiko_tree_names *files,
                                        keiko_tree_walk_budget *budget, unsigned int depth,
                                        uint64_t deadline_ms) {
  int descriptor = relative[0] == '\0'
                       ? dup(root)
                       : keiko_tree_open_relative(root, relative, O_RDONLY | O_DIRECTORY);
  DIR *directory;
  struct dirent *entry;
  int result = 0;
  if (descriptor == -1) return 0;
  if (!keiko_tree_before_deadline(deadline_ms) || depth > KEIKO_TREE_MAX_DEPTH) {
    close(descriptor);
    return 0;
  }
  if (lseek(descriptor, 0, SEEK_SET) == (off_t)-1) {
    close(descriptor);
    return 0;
  }
  directory = fdopendir(descriptor);
  if (directory == NULL) {
    close(descriptor);
    return 0;
  }
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    char *child = NULL;
    struct stat status;
    int child_descriptor;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!keiko_tree_before_deadline(deadline_ms) ||
        !keiko_tree_join_relative(&child, relative, entry->d_name)) goto cleanup;
    if (!keiko_tree_record_entry(budget, child)) {
      free(child);
      goto cleanup;
    }
    child_descriptor = keiko_tree_open_relative(root, child, O_RDONLY);
    if (child_descriptor == -1 || fstat(child_descriptor, &status) != 0 ||
        (S_ISREG(status.st_mode) && status.st_nlink != 1)) {
      if (child_descriptor != -1) close(child_descriptor);
      free(child);
      goto cleanup;
    }
    close(child_descriptor);
    if (S_ISDIR(status.st_mode)) {
      if (!keiko_tree_collect_directory(root, child, files, budget, depth + 1u, deadline_ms)) {
        free(child);
        goto cleanup;
      }
    } else if (S_ISREG(status.st_mode)) {
      if (!keiko_tree_names_add(files, child)) {
        free(child);
        goto cleanup;
      }
    } else {
      free(child);
      goto cleanup;
    }
    free(child);
    errno = 0;
  }
  if (errno == 0) result = 1;
cleanup:
  closedir(directory);
  return result;
}

static int keiko_tree_collect(int root, keiko_tree_names *files, uint64_t deadline_ms) {
  struct stat status;
  keiko_tree_walk_budget budget = {0};
  memset(files, 0, sizeof(*files));
  if (fstat(root, &status) != 0 || !S_ISDIR(status.st_mode) ||
      !keiko_tree_collect_directory(root, "", files, &budget, 0, deadline_ms)) {
    keiko_tree_names_clear(files);
    return 0;
  }
  qsort(files->names, files->count, sizeof(char *), keiko_tree_name_compare);
  return 1;
}

static int keiko_tree_digest_file(int root, const char *name, keiko_sha256 *tree,
                                  uint64_t *total_bytes, uint64_t deadline_ms) {
  int descriptor = keiko_tree_open_relative(root, name, O_RDONLY | O_NONBLOCK);
  struct stat before, after;
  keiko_sha256 file;
  unsigned char file_digest[32], buffer[64u * 1024u];
  uint64_t read_bytes = 0;
  ssize_t count;
  if (descriptor == -1 || fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_nlink != 1 || before.st_size < 0 ||
      (uint64_t)before.st_size > KEIKO_TREE_MAX_FILE_BYTES) {
    if (descriptor != -1) close(descriptor);
    return 0;
  }
  if (!keiko_sha256_init(&file)) {
    close(descriptor);
    return 0;
  }
  for (;;) {
    if (!keiko_tree_before_deadline(deadline_ms)) {
      close(descriptor);
      return 0;
    }
    count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) continue;
      close(descriptor);
      return 0;
    }
    if (count == 0) break;
    read_bytes += (uint64_t)count;
    if (read_bytes > (uint64_t)before.st_size || read_bytes > KEIKO_TREE_MAX_FILE_BYTES) {
      close(descriptor);
      return 0;
    }
    if (!keiko_sha256_update(&file, buffer, (size_t)count)) {
      keiko_sha256_clear(&file);
      close(descriptor);
      return 0;
    }
  }
  if (fstat(descriptor, &after) != 0 || read_bytes != (uint64_t)before.st_size ||
      before.st_dev != after.st_dev || before.st_ino != after.st_ino ||
      before.st_size != after.st_size || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec) {
    close(descriptor);
    return 0;
  }
  close(descriptor);
  if (*total_bytes > KEIKO_TREE_MAX_BYTES - read_bytes) return 0;
  *total_bytes += read_bytes;
  if (!keiko_sha256_final(&file, file_digest) ||
      !keiko_sha256_update(tree, file_digest, sizeof(file_digest))) return 0;
  memset(file_digest, 0, sizeof(file_digest));
  return 1;
}

static int keiko_tree_hash_posix(const char *root_path, uint64_t deadline_ms,
                                 char output[65]) {
  int root = open(root_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  keiko_tree_names before = {0}, after = {0};
  keiko_sha256 tree;
  unsigned char digest[32], count_bytes[4], length_bytes[4];
  uint64_t total_bytes = 0;
  size_t index;
  int result = 0;
  if (root == -1 || !keiko_tree_collect(root, &before, deadline_ms)) goto cleanup;
  if (!keiko_sha256_init(&tree) || !keiko_sha256_update(&tree, "KHT1", 4)) goto cleanup;
  keiko_tree_u32le(count_bytes, (uint32_t)before.count);
  if (!keiko_sha256_update(&tree, count_bytes, sizeof(count_bytes))) goto cleanup;
  for (index = 0; index < before.count; ++index) {
    size_t length = strlen(before.names[index]);
    if (length > UINT32_MAX) goto cleanup;
    keiko_tree_u32le(length_bytes, (uint32_t)length);
    if (!keiko_sha256_update(&tree, length_bytes, sizeof(length_bytes)) ||
        !keiko_sha256_update(&tree, before.names[index], length)) goto cleanup;
    if (!keiko_tree_digest_file(root, before.names[index], &tree, &total_bytes, deadline_ms))
      goto cleanup;
  }
  if (!keiko_tree_collect(root, &after, deadline_ms) || !keiko_tree_same_names(&before, &after))
    goto cleanup;
  if (!keiko_sha256_final(&tree, digest)) goto cleanup;
  keiko_sha256_hex(digest, output);
  memset(digest, 0, sizeof(digest));
  result = 1;
cleanup:
  keiko_tree_names_clear(&before);
  keiko_tree_names_clear(&after);
  if (root != -1) close(root);
  return result;
}

#endif

#endif
