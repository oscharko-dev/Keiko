#ifndef KEIKO_PORTABLE_NATIVE_PROCESS_LINUX_H
#define KEIKO_PORTABLE_NATIVE_PROCESS_LINUX_H

#include <linux/magic.h>
#include <sys/vfs.h>

static int keiko_owner_read_proc(const char *path, char *output, size_t capacity,
                                  uint64_t deadline) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  struct statfs filesystem;
  size_t offset = 0;
  int result = 0;
  if (descriptor < 0 || fstatfs(descriptor, &filesystem) != 0 ||
      filesystem.f_type != PROC_SUPER_MAGIC) goto cleanup;
  while (offset + 1u < capacity && keiko_tree_before_deadline(deadline)) {
    ssize_t count = read(descriptor, output + offset, capacity - offset - 1u);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) break;
    if (count == 0) { output[offset] = '\0'; result = 1; break; }
    offset += (size_t)count;
  }
cleanup:
  if (descriptor >= 0 && close(descriptor) != 0) result = 0;
  return result && keiko_tree_before_deadline(deadline);
}

static int keiko_owner_proc_scalar(const char *content, const char *field, pid_t expected) {
  size_t length = strlen(field);
  int matches = 0;
  for (const char *line = content; line != NULL && *line != '\0'; ) {
    const char *end = strchr(line, '\n');
    if (end == NULL) return 0;
    if ((size_t)(end - line) > length && memcmp(line, field, length) == 0) {
      const char *number = line + length;
      while (number < end && (*number == '\t' || *number == ' ')) ++number;
      if (number == end || *number < '1' || *number > '9') return 0;
      char *after;
      errno = 0;
      long value = strtol(number, &after, 10);
      if (errno != 0 || value != expected) return 0;
      while (after < end && (*after == '\t' || *after == ' ')) ++after;
      if (after != end) return 0;
      ++matches;
    }
    line = end + 1;
  }
  return matches == 1;
}

static inline void keiko_scope_u64(unsigned char *bytes, uint64_t value) {
  for (size_t i = 0; i < 8; ++i) bytes[i] = (unsigned char)(value >> (8u * i));
}

static inline uint64_t keiko_scope_read_u64(const unsigned char *bytes) {
  uint64_t value = 0;
  for (size_t i = 0; i < 8; ++i) value |= (uint64_t)bytes[i] << (8u * i);
  return value;
}

#endif
