#ifndef KEIKO_PORTABLE_UPDATE_COORDINATOR_H
#define KEIKO_PORTABLE_UPDATE_COORDINATOR_H

#include "keiko-portable-tree-hash.h"
#include "keiko-portable-update-engine.h"
#include "keiko-portable-update-protocol.h"

#if !defined(_WIN32)

#if !defined(__APPLE__)
#include <linux/fs.h>
#endif

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef KEIKO_COORDINATOR_KILL
#define KEIKO_COORDINATOR_KILL kill
#endif

#ifndef KEIKO_COORDINATOR_CUTOVER_CHECKPOINT
#define KEIKO_COORDINATOR_CUTOVER_CHECKPOINT(name) (1)
#endif

#define KEIKO_COORDINATOR_MAX_FILE_BYTES (64u * 1024u * 1024u)
#define KEIKO_COORDINATOR_MAX_CONTROL_MS (15u * 60u * 1000u)
#define KEIKO_COORDINATOR_PROBE_MS 3000u
#define KEIKO_COORDINATOR_KRP_MAX_BYTES (128u * 1024u)
#define KEIKO_COORDINATOR_KRP_HEADER_BYTES 12u
#define KEIKO_COORDINATOR_START_GATE_FD 5

typedef struct {
  keiko_handoff_plan plan;
  char state_dir[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char capsule[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char plan_sha256[65];
  char receipt_sha256[65];
  unsigned int receipt_sequence;
  uint64_t old_exit_deadline;
  pid_t supervisor_pid;
  int supervisor_control;
  int supervisor_response;
  int start_gate;
} keiko_coordinator_context;

static int keiko_coordinator_join(char *output, size_t capacity, const char *base,
                                  const char *suffix);
static int keiko_coordinator_file_digest_matches(const char *path, const char *expected,
                                                  uint64_t deadline_ms);

static uint64_t keiko_coordinator_wall_ms(void) {
  struct timeval value;
  if (gettimeofday(&value, NULL) != 0) return UINT64_MAX;
  return (uint64_t)value.tv_sec * UINT64_C(1000) + (uint64_t)value.tv_usec / UINT64_C(1000);
}

static int keiko_coordinator_read_exact_deadline(int descriptor, void *buffer, size_t length,
                                                 uint64_t deadline_ms) {
  unsigned char *bytes = (unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    struct pollfd poll_descriptor = {descriptor, POLLIN | POLLHUP, 0};
    uint64_t now = keiko_tree_now_ms();
    int timeout, ready;
    ssize_t count;
    if (now > deadline_ms) return 0;
    timeout = deadline_ms - now > (uint64_t)INT_MAX ? INT_MAX : (int)(deadline_ms - now);
    ready = poll(&poll_descriptor, 1, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (poll_descriptor.revents & (POLLERR | POLLNVAL)) != 0) return 0;
    count = read(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static int keiko_coordinator_write_exact(int descriptor, const void *buffer, size_t length) {
  const unsigned char *bytes = (const unsigned char *)buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(descriptor, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return 0;
    offset += (size_t)count;
  }
  return 1;
}

static void keiko_coordinator_u16le(unsigned char *value, uint16_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
}

static void keiko_coordinator_u32le(unsigned char *value, uint32_t number) {
  value[0] = (unsigned char)number;
  value[1] = (unsigned char)(number >> 8);
  value[2] = (unsigned char)(number >> 16);
  value[3] = (unsigned char)(number >> 24);
}

static int keiko_coordinator_deadline(const keiko_coordinator_context *context,
                                      unsigned int field, uint64_t *deadline) {
  uint64_t wall, now_wall = keiko_coordinator_wall_ms(), now = keiko_tree_now_ms();
  if (now_wall == UINT64_MAX || now == UINT64_MAX ||
      !keiko_khp_decimal_value(context->plan.field[field], UINT64_C(9007199254740991), &wall) ||
      wall <= now_wall || wall - now_wall > KEIKO_COORDINATOR_MAX_CONTROL_MS) return 0;
  *deadline = now + (wall - now_wall);
  return *deadline >= now;
}

static int keiko_coordinator_set_cloexec(int descriptor) {
  int flags = fcntl(descriptor, F_GETFD);
  return flags != -1 && fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) == 0;
}

static int keiko_coordinator_pipe(int descriptors[2]) {
  if (pipe(descriptors) != 0) return 0;
  if (!keiko_coordinator_set_cloexec(descriptors[0]) ||
      !keiko_coordinator_set_cloexec(descriptors[1])) {
    close(descriptors[0]);
    close(descriptors[1]);
    descriptors[0] = descriptors[1] = -1;
    return 0;
  }
  return 1;
}

static int keiko_coordinator_move_reserved_source(int *descriptor, int reserved) {
  int moved;
  if (*descriptor != reserved) return 1;
  moved = fcntl(*descriptor, F_DUPFD_CLOEXEC, 6);
  if (moved == -1) return 0;
  close(*descriptor);
  *descriptor = moved;
  return 1;
}

/*
 * ADR-0121 requires same-volume atomic rename semantics "or an equally reviewed platform primitive
 * with the same fail-closed property". Darwin offers renameatx_np; Linux exchanges directory
 * entries with renameat2(RENAME_EXCHANGE) and refuses an occupied destination with
 * RENAME_NOREPLACE. Both are single syscalls and fail closed exactly like their Darwin counterparts.
 *
 * RENAME_NOFOLLOW_ANY has no Linux spelling. It fails the rename when ANY path component is a
 * symlink. Every call site below passes a directory descriptor plus a single leaf name, so there is
 * no intermediate component left to follow, and both operations act on the directory entries
 * themselves rather than dereferencing a leaf. The guarantee is preserved structurally, not dropped.
 */
static int keiko_coordinator_exchange_at(int old_parent, const char *old_leaf, int new_parent,
                                         const char *new_leaf) {
#if defined(__APPLE__)
  return renameatx_np(old_parent, old_leaf, new_parent, new_leaf,
                      RENAME_SWAP | RENAME_NOFOLLOW_ANY) == 0;
#else
  return renameat2(old_parent, old_leaf, new_parent, new_leaf, RENAME_EXCHANGE) == 0;
#endif
}

static int keiko_coordinator_relocate_at(int old_parent, const char *old_leaf, int new_parent,
                                         const char *new_leaf) {
#if defined(__APPLE__)
  return renameatx_np(old_parent, old_leaf, new_parent, new_leaf,
                      RENAME_EXCL | RENAME_NOFOLLOW_ANY) == 0;
#else
  return renameat2(old_parent, old_leaf, new_parent, new_leaf, RENAME_NOREPLACE) == 0;
#endif
}

static int keiko_coordinator_same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         left->st_size == right->st_size &&
         KEIKO_TREE_STAT_MTIME(left).tv_sec == KEIKO_TREE_STAT_MTIME(right).tv_sec &&
         KEIKO_TREE_STAT_MTIME(left).tv_nsec == KEIKO_TREE_STAT_MTIME(right).tv_nsec;
}

static int keiko_coordinator_read_file_at(int directory, const char *name, size_t maximum,
                                          uint64_t deadline_ms, unsigned char **output,
                                          size_t *output_length) {
  struct stat named, before, after;
  int descriptor = -1;
  unsigned char *content = NULL;
  size_t offset = 0;
  int result = 0;
  if (!keiko_tree_valid_component(name) ||
      fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(named.st_mode) || named.st_nlink != 1 || named.st_size < 0 ||
      (uint64_t)named.st_size > maximum) return 0;
  descriptor = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (descriptor == -1 || fstat(descriptor, &before) != 0 ||
      !keiko_coordinator_same_file(&named, &before)) goto cleanup;
  content = (unsigned char *)malloc((size_t)before.st_size + 1u);
  if (content == NULL) goto cleanup;
  while (offset < (size_t)before.st_size) {
    ssize_t count;
    if (!keiko_tree_before_deadline(deadline_ms)) goto cleanup;
    count = read(descriptor, content + offset, (size_t)before.st_size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) goto cleanup;
    offset += (size_t)count;
  }
  if (fstat(descriptor, &after) != 0 || !keiko_coordinator_same_file(&before, &after) ||
      fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
      !keiko_coordinator_same_file(&before, &named)) goto cleanup;
  content[offset] = 0;
  *output = content;
  *output_length = offset;
  content = NULL;
  result = 1;
cleanup:
  if (content != NULL) {
    memset(content, 0, (size_t)(before.st_size < 0 ? 0 : before.st_size));
    free(content);
  }
  if (descriptor != -1) close(descriptor);
  return result;
}

static int keiko_coordinator_hash_bytes(const void *content, size_t length, char output[65]) {
  keiko_sha256 hash;
  unsigned char digest[32];
  if (!keiko_sha256_init(&hash) || !keiko_sha256_update(&hash, content, length) ||
      !keiko_sha256_final(&hash, digest)) return 0;
  keiko_sha256_hex(digest, output);
  memset(digest, 0, sizeof(digest));
  return 1;
}

static int keiko_coordinator_append_field(unsigned char *content, size_t capacity, size_t *offset,
                                          const char *value) {
  size_t length = strlen(value);
  if (length > UINT32_MAX || *offset > capacity || capacity - *offset < 4u + length) return 0;
  keiko_tree_u32le(content + *offset, (uint32_t)length);
  *offset += 4u;
  memcpy(content + *offset, value, length);
  *offset += length;
  return 1;
}

static int keiko_coordinator_append_krp_string(unsigned char *content, size_t capacity,
                                               size_t *offset, const char *value) {
  size_t length = strlen(value);
  if (length > UINT32_MAX || *offset > capacity || capacity - *offset < 5u + length) return 0;
  keiko_coordinator_u32le(content + *offset, (uint32_t)length);
  *offset += 4u;
  memcpy(content + *offset, value, length);
  *offset += length;
  content[(*offset)++] = 0;
  return 1;
}

static int keiko_coordinator_active_path(const keiko_coordinator_context *context,
                                         const char *candidate_path, char *output,
                                         size_t capacity) {
  const char *candidate_root = context->plan.field[KEIKO_KHP_CANDIDATE_ROOT];
  const char *managed_root = context->plan.field[KEIKO_KHP_MANAGED_ROOT];
  size_t candidate_length = strlen(candidate_root), managed_length = strlen(managed_root);
  if (strncmp(candidate_path, candidate_root, candidate_length) != 0 ||
      candidate_path[candidate_length] != '/' ||
      managed_length + strlen(candidate_path + candidate_length) + 1u > capacity) return 0;
  memcpy(output, managed_root, managed_length);
  strcpy(output + managed_length, candidate_path + candidate_length);
  return keiko_khp_is_absolute_canonical_path(output);
}

static int keiko_coordinator_launch_packet(const keiko_coordinator_context *context,
                                           const char *executable, int restoring,
                                           unsigned char **output,
                                           size_t *output_length) {
  unsigned char *content = (unsigned char *)calloc(KEIKO_COORDINATOR_KRP_MAX_BYTES, 1u);
  const char *argument1 = restoring ? "--resume-restored-update" : "--resume-update";
  const char *environment_name = "KEIKO_STATE_DIR";
  size_t offset = KEIKO_COORDINATOR_KRP_HEADER_BYTES + 4u;
  uint32_t payload_length;
  if (content == NULL) return 0;
  memcpy(content, "KRP1", 4u);
  keiko_coordinator_u16le(content + 4u, 1u);
  keiko_coordinator_u16le(content + 6u, 1u);
  keiko_coordinator_u16le(content + KEIKO_COORDINATOR_KRP_HEADER_BYTES, 2u);
  keiko_coordinator_u16le(content + KEIKO_COORDINATOR_KRP_HEADER_BYTES + 2u, 1u);
  if (!keiko_coordinator_append_krp_string(
          content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
          context->plan.field[KEIKO_KHP_ACTIVATION_ID]) ||
      !keiko_coordinator_append_krp_string(content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
                                          executable) ||
      !keiko_coordinator_append_krp_string(
          content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
          context->plan.field[KEIKO_KHP_MANAGED_ROOT]) ||
      !keiko_coordinator_append_krp_string(content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
                                          argument1) ||
      !keiko_coordinator_append_krp_string(
          content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
          context->plan.field[KEIKO_KHP_ACTIVATION_ID]) ||
      !keiko_coordinator_append_krp_string(content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
                                          environment_name) ||
      !keiko_coordinator_append_krp_string(content, KEIKO_COORDINATOR_KRP_MAX_BYTES, &offset,
                                          context->state_dir) ||
      offset - KEIKO_COORDINATOR_KRP_HEADER_BYTES > UINT32_MAX) {
    free(content);
    return 0;
  }
  payload_length = (uint32_t)(offset - KEIKO_COORDINATOR_KRP_HEADER_BYTES);
  keiko_coordinator_u32le(content + 8u, payload_length);
  *output = content;
  *output_length = offset;
  return 1;
}

static int keiko_coordinator_receipt_directory(const keiko_coordinator_context *context,
                                               int *descriptor) {
  int capsule = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat status;
  if (capsule == -1) return 0;
  if (mkdirat(capsule, "receipts", 0700) != 0 && errno != EEXIST) {
    close(capsule);
    return 0;
  }
  *descriptor = openat(capsule, "receipts", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  close(capsule);
  if (*descriptor == -1 || fstat(*descriptor, &status) != 0 || !S_ISDIR(status.st_mode) ||
      status.st_uid != geteuid() || (status.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
    if (*descriptor != -1) close(*descriptor);
    *descriptor = -1;
    return 0;
  }
  return 1;
}

static int keiko_coordinator_append_receipt(keiko_coordinator_context *context,
                                            const char *kind, const char *outcome) {
  unsigned char content[4096] = {'K', 'H', 'R', '1', 1, 0, 7, 0};
  char sequence[32], timestamp[32], filename[32], digest[65];
  const char *previous = context->receipt_sequence == 0 ? "" : context->receipt_sha256;
  size_t offset = 8u;
  int directory = -1, descriptor = -1;
  int result = 0;
  uint64_t now = keiko_coordinator_wall_ms();
  if (now == UINT64_MAX ||
      snprintf(sequence, sizeof(sequence), "%u", context->receipt_sequence + 1u) <= 0 ||
      snprintf(timestamp, sizeof(timestamp), "%llu", (unsigned long long)now) <= 0 ||
      snprintf(filename, sizeof(filename), "%06u.khr", context->receipt_sequence + 1u) <= 0 ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset,
                                      context->plan.field[KEIKO_KHP_ACTIVATION_ID]) ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset, context->plan_sha256) ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset, sequence) ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset, kind) ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset, outcome) ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset, timestamp) ||
      !keiko_coordinator_append_field(content, sizeof(content), &offset, previous) ||
      !keiko_coordinator_hash_bytes(content, offset, digest) ||
      !keiko_coordinator_receipt_directory(context, &directory)) goto cleanup;
  descriptor = openat(directory, filename,
                      O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (descriptor == -1 || !keiko_coordinator_write_exact(descriptor, content, offset) ||
      fsync(descriptor) != 0 || close(descriptor) != 0) goto cleanup;
  descriptor = -1;
  if (fsync(directory) != 0) goto cleanup;
  memcpy(context->receipt_sha256, digest, sizeof(context->receipt_sha256));
  context->receipt_sequence += 1u;
  result = 1;
cleanup:
  if (descriptor != -1) close(descriptor);
  if (directory != -1) close(directory);
  memset(content, 0, sizeof(content));
  return result;
}

static int keiko_coordinator_receipt_field(const unsigned char *content, size_t length,
                                           size_t *offset, const unsigned char **value,
                                           size_t *value_length) {
  uint32_t field_length;
  if (*offset > length || length - *offset < 4u) return 0;
  field_length = keiko_khp_read_u32(content + *offset);
  *offset += 4u;
  if ((size_t)field_length > length - *offset) return 0;
  *value = content + *offset;
  *value_length = (size_t)field_length;
  *offset += (size_t)field_length;
  return 1;
}

static int keiko_coordinator_field_equals(const unsigned char *value, size_t length,
                                          const char *expected) {
  return strlen(expected) == length && memcmp(value, expected, length) == 0;
}

static int keiko_coordinator_read_expected_receipt(keiko_coordinator_context *context,
                                                   const char *kind, const char *outcome,
                                                   uint64_t deadline_ms) {
  unsigned char *content = NULL;
  const unsigned char *field[7];
  size_t field_length[7], content_length = 0, offset = 8u, index;
  char filename[32], sequence[32], digest[65];
  int directory = -1, result = 0;
  if (snprintf(filename, sizeof(filename), "%06u.khr", context->receipt_sequence + 1u) <= 0 ||
      snprintf(sequence, sizeof(sequence), "%u", context->receipt_sequence + 1u) <= 0 ||
      !keiko_coordinator_receipt_directory(context, &directory) ||
      !keiko_coordinator_read_file_at(directory, filename, 4096u, deadline_ms, &content,
                                      &content_length) ||
      content_length < 8u || memcmp(content, "KHR1", 4u) != 0 ||
      keiko_khp_read_u16(content + 4u) != 1u || keiko_khp_read_u16(content + 6u) != 7u)
    goto cleanup;
  for (index = 0; index < 7u; ++index)
    if (!keiko_coordinator_receipt_field(content, content_length, &offset, &field[index],
                                         &field_length[index]))
      goto cleanup;
  if (offset != content_length ||
      !keiko_coordinator_field_equals(field[0], field_length[0],
                                      context->plan.field[KEIKO_KHP_ACTIVATION_ID]) ||
      !keiko_coordinator_field_equals(field[1], field_length[1], context->plan_sha256) ||
      !keiko_coordinator_field_equals(field[2], field_length[2], sequence) ||
      !keiko_coordinator_field_equals(field[3], field_length[3], kind) ||
      !keiko_coordinator_field_equals(field[4], field_length[4], outcome) ||
      field_length[5] < 1u || field_length[5] > 16u ||
      (field_length[5] > 1u && field[5][0] == '0') ||
      !keiko_khp_is_utf8(field[5], field_length[5]) ||
      (context->receipt_sequence == 0
           ? field_length[6] != 0
           : !keiko_coordinator_field_equals(field[6], field_length[6],
                                             context->receipt_sha256)))
    goto cleanup;
  for (index = 0; index < field_length[5]; ++index)
    if (field[5][index] < '0' || field[5][index] > '9') goto cleanup;
  if (!keiko_coordinator_hash_bytes(content, content_length, digest)) goto cleanup;
  memcpy(context->receipt_sha256, digest, sizeof(context->receipt_sha256));
  context->receipt_sequence += 1u;
  result = 1;
cleanup:
  if (directory != -1) close(directory);
  if (content != NULL) {
    memset(content, 0, content_length);
    free(content);
  }
  return result;
}

static int keiko_coordinator_wait_expected_receipt(keiko_coordinator_context *context,
                                                   const char *kind, const char *outcome,
                                                   uint64_t deadline_ms) {
  char path[KEIKO_KHP_MAX_PATH_BYTES + 1], suffix[64];
  struct stat status;
  if (snprintf(suffix, sizeof(suffix), "/receipts/%06u.khr",
               context->receipt_sequence + 1u) <= 0 ||
      !keiko_coordinator_join(path, sizeof(path), context->capsule, suffix)) return 0;
  while (keiko_tree_before_deadline(deadline_ms)) {
    if (lstat(path, &status) == 0)
      return keiko_coordinator_read_expected_receipt(context, kind, outcome, deadline_ms);
    if (errno != ENOENT) return 0;
    usleep(10000);
  }
  return 0;
}

static int keiko_coordinator_wait_verified_ack(keiko_coordinator_context *context,
                                               uint64_t deadline_ms) {
  unsigned char *content = NULL;
  size_t length = 0;
  int capsule = -1, result = 0;
  struct stat status;
  char path[KEIKO_KHP_MAX_PATH_BYTES + 1];
  if (!keiko_coordinator_join(path, sizeof(path), context->capsule, "/verified.ack")) return 0;
  while (keiko_tree_before_deadline(deadline_ms)) {
    if (lstat(path, &status) == 0) break;
    if (errno != ENOENT) return 0;
    usleep(10000);
  }
  if (!keiko_tree_before_deadline(deadline_ms)) return 0;
  capsule = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (capsule == -1 ||
      !keiko_coordinator_read_file_at(capsule, "verified.ack", 69u, deadline_ms, &content,
                                      &length) ||
      length != 69u || memcmp(content, "KHV1", 4u) != 0 || content[68] != '\n' ||
      memcmp(content + 4u, context->plan_sha256, 64u) != 0)
    goto cleanup;
  result = 1;
cleanup:
  if (capsule != -1) close(capsule);
  if (content != NULL) {
    memset(content, 0, length);
    free(content);
  }
  return result;
}

static int keiko_coordinator_emit_acceptance(keiko_coordinator_context *context) {
  char response[70];
  int result;
  if (!keiko_coordinator_append_receipt(context, "prepared", "completed") ||
      !keiko_coordinator_append_receipt(context, "old-exit", "intent")) return 0;
  memcpy(response, "KHA1", 4u);
  memcpy(response + 4u, context->plan_sha256, 64u);
  response[68] = '\n';
  result = keiko_coordinator_write_exact(3, response, 69u);
  close(3);
  return result;
}

static int keiko_coordinator_wait_parent_eof(uint64_t deadline_ms) {
  for (;;) {
    struct pollfd descriptor = {STDIN_FILENO, POLLIN | POLLHUP, 0};
    uint64_t now = keiko_tree_now_ms();
    int timeout, ready;
    unsigned char unexpected;
    ssize_t count;
    if (now > deadline_ms) return 0;
    timeout = deadline_ms - now > (uint64_t)INT_MAX ? INT_MAX : (int)(deadline_ms - now);
    ready = poll(&descriptor, 1, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (descriptor.revents & (POLLERR | POLLNVAL)) != 0) return 0;
    count = read(STDIN_FILENO, &unexpected, 1u);
    if (count < 0 && errno == EINTR) continue;
    return count == 0;
  }
}

static int keiko_coordinator_port_bindable(const keiko_coordinator_context *context) {
  struct sockaddr_in address;
  uint64_t port;
  int descriptor, result;
  if (!keiko_khp_decimal_value(context->plan.field[KEIKO_KHP_OLD_PORT], 65535u, &port) ||
      port == 0) return 0;
  descriptor = socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor == -1) return 0;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)port);
  result = bind(descriptor, (struct sockaddr *)&address, sizeof(address)) == 0;
  close(descriptor);
  return result;
}

static int keiko_coordinator_wait_old_exit(keiko_coordinator_context *context) {
  uint64_t pid_value;
  pid_t old_pid;
  if (!keiko_khp_decimal_value(context->plan.field[KEIKO_KHP_OLD_PID], INT32_MAX, &pid_value))
    return 0;
  old_pid = (pid_t)pid_value;
  if (!keiko_coordinator_wait_parent_eof(context->old_exit_deadline)) return 0;
  while (keiko_tree_before_deadline(context->old_exit_deadline)) {
    if (kill(old_pid, 0) != 0 && errno == ESRCH && keiko_coordinator_port_bindable(context)) {
      return keiko_coordinator_append_receipt(context, "old-exit", "completed");
    }
    usleep(10000);
  }
  return 0;
}

enum {
  KEIKO_COORDINATOR_TREE_INVALID = -1,
  KEIKO_COORDINATOR_TREE_ABSENT = 0,
  KEIKO_COORDINATOR_TREE_CURRENT = 1,
  KEIKO_COORDINATOR_TREE_CANDIDATE = 2
};

enum {
  KEIKO_COORDINATOR_REGISTRATION_INVALID = -1,
  KEIKO_COORDINATOR_REGISTRATION_PREVIOUS = 1,
  KEIKO_COORDINATOR_REGISTRATION_PREPARED = 2
};

enum {
  KEIKO_COORDINATOR_SHAPE_INVALID = -1,
  KEIKO_COORDINATOR_SHAPE_INITIAL = 1,
  KEIKO_COORDINATOR_SHAPE_EXCHANGED = 2,
  KEIKO_COORDINATOR_SHAPE_PROMOTED = 3,
  KEIKO_COORDINATOR_SHAPE_RESTORED_BACKUP = 4
};

typedef struct {
  int parent;
  int root;
  char leaf[NAME_MAX + 1u];
  struct stat parent_identity;
  struct stat root_identity;
  int tree;
} keiko_coordinator_binding;

typedef struct {
  keiko_coordinator_binding managed;
  keiko_coordinator_binding candidate;
  keiko_coordinator_binding backup;
  int registration;
  int shape;
} keiko_coordinator_cutover_state;

static int keiko_coordinator_same_directory(const struct stat *left,
                                            const struct stat *right) {
  return S_ISDIR(left->st_mode) && S_ISDIR(right->st_mode) &&
         left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static void keiko_coordinator_binding_clear(keiko_coordinator_binding *binding) {
  if (binding->root != -1) close(binding->root);
  if (binding->parent != -1) close(binding->parent);
  memset(binding, 0, sizeof(*binding));
  binding->parent = -1;
  binding->root = -1;
  binding->tree = KEIKO_COORDINATOR_TREE_INVALID;
}

static void keiko_coordinator_cutover_state_clear(keiko_coordinator_cutover_state *state) {
  keiko_coordinator_binding_clear(&state->managed);
  keiko_coordinator_binding_clear(&state->candidate);
  keiko_coordinator_binding_clear(&state->backup);
  state->registration = KEIKO_COORDINATOR_REGISTRATION_INVALID;
  state->shape = KEIKO_COORDINATOR_SHAPE_INVALID;
}

static int keiko_coordinator_open_directory_path(const char *path) {
  char *storage, *cursor, *separator;
  int current, next;
  size_t length = strlen(path);
  if (length < 2u || path[0] != '/' || path[length - 1u] == '/') return -1;
  storage = (char *)malloc(length + 1u);
  if (storage == NULL) return -1;
  memcpy(storage, path, length + 1u);
  current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (current == -1) {
    free(storage);
    return -1;
  }
  cursor = storage + 1u;
  for (;;) {
    separator = strchr(cursor, '/');
    if (separator != NULL) *separator = '\0';
    if (!keiko_tree_valid_component(cursor)) {
      close(current);
      free(storage);
      return -1;
    }
    next = openat(current, cursor, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    close(current);
    if (next == -1) {
      free(storage);
      return -1;
    }
    if (separator == NULL) break;
    current = next;
    cursor = separator + 1u;
  }
  free(storage);
  return next;
}

static int keiko_coordinator_binding_open(
    keiko_coordinator_binding *binding, const char *path, const char *current_digest,
    const char *candidate_digest, uint64_t deadline_ms) {
  char *storage = NULL, *separator;
  struct stat named, opened;
  char digest[65];
  size_t length = strlen(path), leaf_length;
  int result = 0;
  memset(binding, 0, sizeof(*binding));
  binding->parent = -1;
  binding->root = -1;
  binding->tree = KEIKO_COORDINATOR_TREE_INVALID;
  if (length == 0 || length > KEIKO_KHP_MAX_PATH_BYTES ||
      strcmp(current_digest, candidate_digest) == 0)
    return 0;
  storage = (char *)malloc(length + 1u);
  if (storage == NULL) return 0;
  memcpy(storage, path, length + 1u);
  separator = strrchr(storage, '/');
  if (separator == NULL || separator == storage || separator[1] == '\0') goto cleanup;
  leaf_length = strlen(separator + 1u);
  if (leaf_length > NAME_MAX || !keiko_tree_valid_component(separator + 1u)) goto cleanup;
  memcpy(binding->leaf, separator + 1u, leaf_length + 1u);
  *separator = '\0';
  binding->parent = keiko_coordinator_open_directory_path(storage);
  if (binding->parent == -1 || fstat(binding->parent, &binding->parent_identity) != 0 ||
      !S_ISDIR(binding->parent_identity.st_mode))
    goto cleanup;
  errno = 0;
  if (fstatat(binding->parent, binding->leaf, &named, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT) goto cleanup;
    binding->tree = KEIKO_COORDINATOR_TREE_ABSENT;
    result = 1;
    goto cleanup;
  }
  if (!S_ISDIR(named.st_mode)) goto cleanup;
  binding->root = openat(binding->parent, binding->leaf,
                         O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (binding->root == -1 || fstat(binding->root, &opened) != 0 ||
      !keiko_coordinator_same_directory(&named, &opened) ||
      !keiko_tree_hash_posix_fd(binding->root, deadline_ms, digest))
    goto cleanup;
  binding->root_identity = opened;
  if (strcmp(digest, current_digest) == 0)
    binding->tree = KEIKO_COORDINATOR_TREE_CURRENT;
  else if (strcmp(digest, candidate_digest) == 0)
    binding->tree = KEIKO_COORDINATOR_TREE_CANDIDATE;
  else
    goto cleanup;
  result = 1;
cleanup:
  free(storage);
  if (!result) keiko_coordinator_binding_clear(binding);
  return result;
}

static int keiko_coordinator_registration_state(const keiko_coordinator_context *context,
                                                uint64_t deadline_ms) {
  char registration[KEIKO_KHP_MAX_PATH_BYTES + 1];
  int previous, prepared;
  if (!keiko_coordinator_join(registration, sizeof(registration), context->state_dir,
                              "/portable-install-state.json"))
    return KEIKO_COORDINATOR_REGISTRATION_INVALID;
  previous = keiko_coordinator_file_digest_matches(
      registration, context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256], deadline_ms);
  prepared = keiko_coordinator_file_digest_matches(
      registration, context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256], deadline_ms);
  if (previous == prepared) return KEIKO_COORDINATOR_REGISTRATION_INVALID;
  return previous ? KEIKO_COORDINATOR_REGISTRATION_PREVIOUS
                  : KEIKO_COORDINATOR_REGISTRATION_PREPARED;
}

static int keiko_coordinator_cutover_classify(const keiko_coordinator_context *context,
                                              uint64_t deadline_ms,
                                              keiko_coordinator_cutover_state *state) {
  dev_t device;
  memset(state, 0, sizeof(*state));
  state->managed.parent = state->managed.root = -1;
  state->candidate.parent = state->candidate.root = -1;
  state->backup.parent = state->backup.root = -1;
  state->registration = KEIKO_COORDINATOR_REGISTRATION_INVALID;
  state->shape = KEIKO_COORDINATOR_SHAPE_INVALID;
  if (!keiko_tree_before_deadline(deadline_ms) ||
      !keiko_coordinator_binding_open(
          &state->managed, context->plan.field[KEIKO_KHP_MANAGED_ROOT],
          context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256],
          context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256], deadline_ms) ||
      !keiko_coordinator_binding_open(
          &state->candidate, context->plan.field[KEIKO_KHP_CANDIDATE_ROOT],
          context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256],
          context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256], deadline_ms) ||
      !keiko_coordinator_binding_open(
          &state->backup, context->plan.field[KEIKO_KHP_BACKUP_ROOT],
          context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256],
          context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256], deadline_ms))
    goto invalid;
  device = state->managed.parent_identity.st_dev;
  if (!keiko_coordinator_same_directory(&state->managed.parent_identity,
                                        &state->backup.parent_identity) ||
      state->candidate.parent_identity.st_dev != device ||
      (state->managed.root != -1 && state->managed.root_identity.st_dev != device) ||
      (state->candidate.root != -1 && state->candidate.root_identity.st_dev != device) ||
      (state->backup.root != -1 && state->backup.root_identity.st_dev != device))
    goto invalid;
  state->registration = keiko_coordinator_registration_state(context, deadline_ms);
  if (state->registration == KEIKO_COORDINATOR_REGISTRATION_INVALID) goto invalid;
  if (state->managed.tree == KEIKO_COORDINATOR_TREE_CURRENT &&
      state->candidate.tree == KEIKO_COORDINATOR_TREE_CANDIDATE &&
      state->backup.tree == KEIKO_COORDINATOR_TREE_ABSENT)
    state->shape = KEIKO_COORDINATOR_SHAPE_INITIAL;
  else if (state->managed.tree == KEIKO_COORDINATOR_TREE_CANDIDATE &&
           state->candidate.tree == KEIKO_COORDINATOR_TREE_CURRENT &&
           state->backup.tree == KEIKO_COORDINATOR_TREE_ABSENT)
    state->shape = KEIKO_COORDINATOR_SHAPE_EXCHANGED;
  else if (state->managed.tree == KEIKO_COORDINATOR_TREE_CANDIDATE &&
           state->candidate.tree == KEIKO_COORDINATOR_TREE_ABSENT &&
           state->backup.tree == KEIKO_COORDINATOR_TREE_CURRENT)
    state->shape = KEIKO_COORDINATOR_SHAPE_PROMOTED;
  else if (state->managed.tree == KEIKO_COORDINATOR_TREE_CURRENT &&
           state->candidate.tree == KEIKO_COORDINATOR_TREE_ABSENT &&
           state->backup.tree == KEIKO_COORDINATOR_TREE_CANDIDATE)
    state->shape = KEIKO_COORDINATOR_SHAPE_RESTORED_BACKUP;
  else
    goto invalid;
  return 1;
invalid:
  keiko_coordinator_cutover_state_clear(state);
  return 0;
}

static int keiko_coordinator_binding_named_as(const keiko_coordinator_binding *name,
                                              const keiko_coordinator_binding *identity) {
  struct stat current;
  return identity->root != -1 &&
         fstatat(name->parent, name->leaf, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
         keiko_coordinator_same_directory(&current, &identity->root_identity);
}

static int keiko_coordinator_binding_absent(const keiko_coordinator_binding *binding) {
  struct stat status;
  errno = 0;
  return fstatat(binding->parent, binding->leaf, &status, AT_SYMLINK_NOFOLLOW) != 0 &&
         errno == ENOENT;
}

static int keiko_coordinator_binding_digest(const keiko_coordinator_binding *binding,
                                            const char *expected, uint64_t deadline_ms) {
  char actual[65];
  return binding->root != -1 &&
         keiko_tree_hash_posix_fd(binding->root, deadline_ms, actual) &&
         strcmp(actual, expected) == 0;
}

static int keiko_coordinator_sync_bindings(const keiko_coordinator_binding *left,
                                           const keiko_coordinator_binding *right) {
  if (fsync(left->parent) != 0) return 0;
  return keiko_coordinator_same_directory(&left->parent_identity, &right->parent_identity) ||
         fsync(right->parent) == 0;
}

static int keiko_coordinator_promote_roots(keiko_coordinator_context *context,
                                           uint64_t deadline_ms) {
  keiko_coordinator_cutover_state state;
  const keiko_coordinator_binding *old_binding, *new_binding;
  int result = 0;
  if (!keiko_coordinator_cutover_classify(context, deadline_ms, &state)) return 0;
  if (state.registration != KEIKO_COORDINATOR_REGISTRATION_PREVIOUS ||
      (state.shape != KEIKO_COORDINATOR_SHAPE_INITIAL &&
       state.shape != KEIKO_COORDINATOR_SHAPE_EXCHANGED &&
       state.shape != KEIKO_COORDINATOR_SHAPE_PROMOTED))
    goto cleanup;
  old_binding = state.managed.tree == KEIKO_COORDINATOR_TREE_CURRENT
                    ? &state.managed
                    : state.candidate.tree == KEIKO_COORDINATOR_TREE_CURRENT
                          ? &state.candidate
                          : &state.backup;
  new_binding = state.managed.tree == KEIKO_COORDINATOR_TREE_CANDIDATE
                    ? &state.managed
                    : &state.candidate;
  if (state.shape == KEIKO_COORDINATOR_SHAPE_INITIAL) {
    if (!keiko_coordinator_binding_named_as(&state.managed, old_binding) ||
        !keiko_coordinator_binding_named_as(&state.candidate, new_binding) ||
        !keiko_coordinator_binding_absent(&state.backup) ||
        !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("promote-before-exchange") ||
        !keiko_coordinator_exchange_at(state.managed.parent, state.managed.leaf,
                                       state.candidate.parent, state.candidate.leaf) ||
        !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("promote-after-exchange") ||
        !keiko_coordinator_sync_bindings(&state.managed, &state.candidate) ||
        !keiko_coordinator_binding_named_as(&state.managed, new_binding) ||
        !keiko_coordinator_binding_named_as(&state.candidate, old_binding) ||
        !keiko_coordinator_binding_digest(
            old_binding, context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256], deadline_ms) ||
        !keiko_coordinator_binding_digest(
            new_binding, context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256], deadline_ms) ||
        !keiko_coordinator_binding_named_as(&state.managed, new_binding) ||
        !keiko_coordinator_binding_named_as(&state.candidate, old_binding))
      goto cleanup;
  } else if (state.shape == KEIKO_COORDINATOR_SHAPE_PROMOTED) {
    result = 1;
    goto cleanup;
  }
  if (!keiko_coordinator_binding_named_as(&state.managed, new_binding) ||
      !keiko_coordinator_binding_named_as(&state.candidate, old_binding) ||
      !keiko_coordinator_binding_absent(&state.backup) ||
      !keiko_coordinator_relocate_at(state.candidate.parent, state.candidate.leaf,
                                     state.backup.parent, state.backup.leaf) ||
      !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("promote-after-relocation") ||
      !keiko_coordinator_sync_bindings(&state.candidate, &state.backup) ||
      !keiko_coordinator_binding_named_as(&state.managed, new_binding) ||
      !keiko_coordinator_binding_absent(&state.candidate) ||
      !keiko_coordinator_binding_named_as(&state.backup, old_binding) ||
      !keiko_coordinator_binding_digest(
          old_binding, context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256], deadline_ms) ||
      !keiko_coordinator_binding_digest(
          new_binding, context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256], deadline_ms) ||
      !keiko_coordinator_binding_named_as(&state.managed, new_binding) ||
      !keiko_coordinator_binding_absent(&state.candidate) ||
      !keiko_coordinator_binding_named_as(&state.backup, old_binding))
    goto cleanup;
  result = 1;
cleanup:
  keiko_coordinator_cutover_state_clear(&state);
  return result;
}

static int keiko_coordinator_promote(keiko_coordinator_context *context, uint64_t deadline_ms) {
  if (!keiko_tree_before_deadline(deadline_ms) ||
      !keiko_coordinator_append_receipt(context, "promote", "intent") ||
      !keiko_coordinator_promote_roots(context, deadline_ms) ||
      !keiko_coordinator_append_receipt(context, "promote", "completed")) return 0;
  return 1;
}

static int keiko_coordinator_promoted_registration(
    const keiko_coordinator_context *context, uint64_t deadline_ms, int *registration) {
  keiko_coordinator_cutover_state state;
  int result;
  if (!keiko_coordinator_cutover_classify(context, deadline_ms, &state)) return 0;
  result = state.shape == KEIKO_COORDINATOR_SHAPE_PROMOTED;
  if (result) *registration = state.registration;
  keiko_coordinator_cutover_state_clear(&state);
  return result;
}

static int keiko_coordinator_publish_registration(keiko_coordinator_context *context,
                                                  uint64_t deadline_ms) {
  unsigned char *content = NULL;
  size_t content_length = 0;
  char destination[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char temporary_name[96] = "";
  char actual[65];
  int capsule = -1, state = -1, descriptor = -1;
  int result = 0;
  struct stat current;
  int registration_state;
  if (!keiko_tree_before_deadline(deadline_ms) ||
      !keiko_coordinator_promoted_registration(context, deadline_ms, &registration_state))
    goto cleanup;
  if (registration_state == KEIKO_COORDINATOR_REGISTRATION_PREPARED) {
    result = keiko_coordinator_append_receipt(context, "register", "completed");
    goto cleanup;
  }
  if (registration_state != KEIKO_COORDINATOR_REGISTRATION_PREVIOUS ||
      !keiko_coordinator_append_receipt(context, "register", "intent") ||
      !keiko_coordinator_join(destination, sizeof(destination), context->state_dir,
                              "/portable-install-state.json") ||
      lstat(destination, &current) != 0 || !S_ISREG(current.st_mode) || current.st_nlink != 1 ||
      !keiko_coordinator_file_digest_matches(
          destination, context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256], deadline_ms))
    goto cleanup;
  capsule = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  state = open(context->state_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (capsule == -1 || state == -1 ||
      !keiko_coordinator_read_file_at(capsule, "registration.next", 64u * 1024u, deadline_ms,
                                      &content, &content_length) ||
      !keiko_coordinator_hash_bytes(content, content_length, actual) ||
      strcmp(actual, context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256]) != 0 ||
      snprintf(temporary_name, sizeof(temporary_name), ".portable-install-state.%ld.handoff",
               (long)getpid()) <= 0) goto cleanup;
  descriptor = openat(state, temporary_name,
                      O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (descriptor == -1 ||
      !keiko_coordinator_write_exact(descriptor, content, content_length) ||
      fsync(descriptor) != 0 || close(descriptor) != 0) goto cleanup;
  descriptor = -1;
  if (renameat(state, temporary_name, state, "portable-install-state.json") != 0 ||
      !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("register-after-publish") ||
      fsync(state) != 0 ||
      !keiko_coordinator_file_digest_matches(
          destination, context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256], deadline_ms) ||
      !keiko_coordinator_append_receipt(context, "register", "completed")) goto cleanup;
  result = 1;
cleanup:
  if (descriptor != -1) close(descriptor);
  if (state != -1 && temporary_name[0] != '\0') {
    (void)unlinkat(state, temporary_name, 0);
  }
  if (state != -1) {
    close(state);
  }
  if (capsule != -1) close(capsule);
  if (content != NULL) {
    memset(content, 0, content_length);
    free(content);
  }
  return result;
}

static int keiko_coordinator_spawn_supervisor(keiko_coordinator_context *context,
                                              uint64_t deadline_ms, int restoring) {
  char supervisor[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char active_launcher[KEIKO_KHP_MAX_PATH_BYTES + 1];
  unsigned char *packet = NULL;
  size_t packet_length = 0;
  int control[2] = {-1, -1}, response[2] = {-1, -1}, gate[2] = {-1, -1};
  int action_initialized = 0, result = 0, spawn_result;
  posix_spawn_file_actions_t actions;
  char *const arguments[] = {supervisor, NULL};
  char *const environment[] = {NULL};
  unsigned char header[KEIKO_COORDINATOR_KRP_HEADER_BYTES];
  if (!keiko_tree_before_deadline(deadline_ms) ||
      !keiko_coordinator_join(supervisor, sizeof(supervisor), context->capsule,
                              "/runtime-supervisor") ||
      !keiko_coordinator_active_path(context,
                                     context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER],
                                     active_launcher, sizeof(active_launcher)) ||
      !keiko_coordinator_file_digest_matches(
          active_launcher,
          context->plan.field[restoring ? KEIKO_KHP_CURRENT_LAUNCHER_SHA256
                                        : KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline_ms) ||
      !keiko_coordinator_launch_packet(context, active_launcher, restoring, &packet,
                                       &packet_length) ||
      !keiko_coordinator_pipe(control) || !keiko_coordinator_pipe(response) ||
      !keiko_coordinator_pipe(gate) ||
      !keiko_coordinator_move_reserved_source(&control[0], 3) ||
      !keiko_coordinator_move_reserved_source(&response[1], 4) ||
      !keiko_coordinator_move_reserved_source(&gate[0], KEIKO_COORDINATOR_START_GATE_FD) ||
      posix_spawn_file_actions_init(&actions) != 0)
    goto cleanup;
  action_initialized = 1;
  if ((control[0] != 3 && posix_spawn_file_actions_adddup2(&actions, control[0], 3) != 0) ||
      (response[1] != 4 && posix_spawn_file_actions_adddup2(&actions, response[1], 4) != 0) ||
      (gate[0] != KEIKO_COORDINATOR_START_GATE_FD &&
       posix_spawn_file_actions_adddup2(&actions, gate[0], KEIKO_COORDINATOR_START_GATE_FD) != 0))
    goto cleanup;
  {
    int descriptors[] = {control[0], control[1], response[0], response[1], gate[0], gate[1]};
    size_t index;
    for (index = 0; index < sizeof(descriptors) / sizeof(descriptors[0]); ++index) {
      int descriptor = descriptors[index];
      if (descriptor != 3 && descriptor != 4 && descriptor != KEIKO_COORDINATOR_START_GATE_FD &&
          posix_spawn_file_actions_addclose(&actions, descriptor) != 0)
        goto cleanup;
    }
  }
  spawn_result = posix_spawn(&context->supervisor_pid, supervisor, &actions, NULL, arguments,
                             environment);
  if (spawn_result != 0) {
    context->supervisor_pid = -1;
    goto cleanup;
  }
  close(control[0]);
  control[0] = -1;
  close(response[1]);
  response[1] = -1;
  close(gate[0]);
  gate[0] = -1;
  context->supervisor_control = control[1];
  control[1] = -1;
  context->supervisor_response = response[0];
  response[0] = -1;
  context->start_gate = gate[1];
  gate[1] = -1;
  if (!keiko_coordinator_write_exact(context->supervisor_control, packet, packet_length) ||
      !keiko_coordinator_read_exact_deadline(context->supervisor_response, header, sizeof(header),
                                             deadline_ms) ||
      memcmp(header, "KRS1", 4u) != 0 || keiko_khp_read_u16(header + 4u) != 1u ||
      keiko_khp_read_u16(header + 6u) != 1u || keiko_khp_read_u32(header + 8u) != 0u)
    goto cleanup;
  result = 1;
cleanup:
  if (action_initialized) posix_spawn_file_actions_destroy(&actions);
  if (packet != NULL) {
    memset(packet, 0, packet_length);
    free(packet);
  }
  if (control[0] != -1) close(control[0]);
  if (control[1] != -1) close(control[1]);
  if (response[0] != -1) close(response[0]);
  if (response[1] != -1) close(response[1]);
  if (gate[0] != -1) close(gate[0]);
  if (gate[1] != -1) close(gate[1]);
  return result;
}

static int keiko_coordinator_start_runtime(keiko_coordinator_context *context,
                                           uint64_t deadline_ms, int restoring) {
  char gate[65];
  if (!keiko_tree_before_deadline(deadline_ms) ||
      !keiko_coordinator_append_receipt(context, restoring ? "restored-start" : "start",
                                        "intent") ||
      !keiko_coordinator_spawn_supervisor(context, deadline_ms, restoring) ||
      !keiko_coordinator_append_receipt(context, restoring ? "restored-start" : "start",
                                        "completed")) return 0;
  memcpy(gate, context->plan_sha256, 64u);
  gate[64] = '\n';
  if (!keiko_coordinator_write_exact(context->start_gate, gate, sizeof(gate))) return 0;
  close(context->start_gate);
  context->start_gate = -1;
  return 1;
}

static int keiko_coordinator_waitpid_deadline(pid_t child, int *status,
                                              uint64_t deadline_ms) {
  while (keiko_tree_before_deadline(deadline_ms)) {
    pid_t waited = waitpid(child, status, WNOHANG);
    if (waited == child) return 1;
    if (waited < 0 && errno != EINTR) return 0;
    usleep(10000);
  }
  errno = ETIMEDOUT;
  return 0;
}

static int keiko_coordinator_stop_runtime(keiko_coordinator_context *context,
                                          uint64_t deadline_ms) {
  unsigned char control[12] = {'K', 'R', 'C', '1', 1, 0, 3, 0, 0, 0, 0, 0};
  unsigned char response[20];
  int status = 0;
  if (context->supervisor_pid <= 0 || context->supervisor_control < 0 ||
      context->supervisor_response < 0 ||
      !keiko_coordinator_write_exact(context->supervisor_control, control, sizeof(control)))
    return 0;
  close(context->supervisor_control);
  context->supervisor_control = -1;
  if (!keiko_coordinator_read_exact_deadline(context->supervisor_response, response, 12u,
                                             deadline_ms) ||
      memcmp(response, "KRS1", 4u) != 0 || keiko_khp_read_u16(response + 4u) != 1u ||
      keiko_khp_read_u16(response + 6u) != 2u || keiko_khp_read_u32(response + 8u) != 8u ||
      !keiko_coordinator_read_exact_deadline(context->supervisor_response, response + 12u, 8u,
                                             deadline_ms) ||
      keiko_khp_read_u32(response + 16u) != 0u ||
      !keiko_coordinator_waitpid_deadline(context->supervisor_pid, &status, deadline_ms) ||
      !WIFEXITED(status) || WEXITSTATUS(status) != 0)
    return 0;
  close(context->supervisor_response);
  context->supervisor_response = -1;
  context->supervisor_pid = -1;
  return 1;
}

static int keiko_coordinator_reconcile_stopped_runtime(
    const keiko_coordinator_context *context, uint64_t deadline_ms) {
  char supervisor[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char *const environment[] = {NULL};
  char *arguments[4];
  unsigned char response[20];
  int output[2] = {-1, -1};
  int actions_initialized = 0, status = 0, result = 0;
  pid_t child = -1;
  posix_spawn_file_actions_t actions;
  uint64_t cleanup_deadline;
  if (!keiko_tree_before_deadline(deadline_ms) ||
      !keiko_coordinator_join(supervisor, sizeof(supervisor), context->capsule,
                              "/runtime-supervisor") ||
      !keiko_coordinator_file_digest_matches(
          supervisor, context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256], deadline_ms) ||
      !keiko_coordinator_pipe(output) ||
      !keiko_coordinator_move_reserved_source(&output[1], 4) ||
      posix_spawn_file_actions_init(&actions) != 0)
    goto cleanup;
  actions_initialized = 1;
  if ((output[1] != 4 && posix_spawn_file_actions_adddup2(&actions, output[1], 4) != 0) ||
      (output[0] != 4 && posix_spawn_file_actions_addclose(&actions, output[0]) != 0) ||
      (output[1] != 4 && posix_spawn_file_actions_addclose(&actions, output[1]) != 0))
    goto cleanup;
  arguments[0] = supervisor;
  arguments[1] = (char *)"--reconcile";
  arguments[2] = context->plan.field[KEIKO_KHP_ACTIVATION_ID];
  arguments[3] = NULL;
  if (posix_spawn(&child, supervisor, &actions, NULL, arguments, environment) != 0) {
    child = -1;
    goto cleanup;
  }
  close(output[1]);
  output[1] = -1;
  if (!keiko_coordinator_read_exact_deadline(output[0], response, sizeof(response), deadline_ms))
    goto cleanup;
  if (memcmp(response, "KRS1", 4u) != 0 || keiko_khp_read_u16(response + 4u) != 1u ||
      keiko_khp_read_u16(response + 6u) != 2u || keiko_khp_read_u32(response + 8u) != 8u ||
      keiko_khp_read_u32(response + 12u) != 0u || keiko_khp_read_u32(response + 16u) != 0u)
    goto cleanup;
  if (!keiko_coordinator_waitpid_deadline(child, &status, deadline_ms)) {
    if (errno == ECHILD) child = -1;
    goto cleanup;
  }
  /* waitpid transferred the process out of the kernel table. Drop numeric-PID authority before
   * inspecting its status: a later kill could otherwise target an unrelated process after reuse. */
  child = -1;
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) goto cleanup;
  result = 1;
cleanup:
  if (actions_initialized) posix_spawn_file_actions_destroy(&actions);
  if (output[0] != -1) close(output[0]);
  if (output[1] != -1) close(output[1]);
  if (child > 0) {
    (void)KEIKO_COORDINATOR_KILL(child, SIGKILL);
    cleanup_deadline = keiko_tree_now_ms();
    if (cleanup_deadline != UINT64_MAX &&
        cleanup_deadline <= UINT64_MAX - KEIKO_COORDINATOR_PROBE_MS) {
      cleanup_deadline += KEIKO_COORDINATOR_PROBE_MS;
      (void)keiko_coordinator_waitpid_deadline(child, &status, cleanup_deadline);
    }
  }
  memset(response, 0, sizeof(response));
  return result;
}

static int keiko_coordinator_stop_failed_start(keiko_coordinator_context *context,
                                               uint64_t deadline_ms) {
  int status = 0;
  if (context->start_gate >= 0) {
    close(context->start_gate);
    context->start_gate = -1;
  }
  /* Closing the exact supervisor's control pipe is itself a bounded stop request: the fixed KRP1
   * implementation treats POLLHUP as STOP even when its initial response became ambiguous. */
  if (context->supervisor_control >= 0) {
    close(context->supervisor_control);
    context->supervisor_control = -1;
  }
  if (context->supervisor_pid > 0) {
    if (!keiko_coordinator_waitpid_deadline(context->supervisor_pid, &status, deadline_ms)) return 0;
    context->supervisor_pid = -1;
  }
  if (context->supervisor_response >= 0) {
    close(context->supervisor_response);
    context->supervisor_response = -1;
  }
  return keiko_coordinator_reconcile_stopped_runtime(context, deadline_ms);
}

static int keiko_coordinator_restore_registration(keiko_coordinator_context *context,
                                                  uint64_t deadline_ms) {
  unsigned char *content = NULL;
  size_t content_length = 0;
  char destination[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char temporary_name[96] = "";
  char actual[65];
  int capsule = -1, state = -1, descriptor = -1;
  int result = 0;
  if (!keiko_coordinator_join(destination, sizeof(destination), context->state_dir,
                              "/portable-install-state.json"))
    return 0;
  capsule = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  state = open(context->state_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (capsule == -1 || state == -1 ||
      !keiko_coordinator_file_digest_matches(
          destination, context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256], deadline_ms) ||
      !keiko_coordinator_read_file_at(capsule, "registration.previous", 64u * 1024u,
                                      deadline_ms, &content, &content_length) ||
      !keiko_coordinator_hash_bytes(content, content_length, actual) ||
      strcmp(actual, context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256]) != 0 ||
      snprintf(temporary_name, sizeof(temporary_name), ".portable-install-state.%ld.restore",
               (long)getpid()) <= 0)
    goto cleanup;
  descriptor = openat(state, temporary_name,
                      O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (descriptor == -1 || !keiko_coordinator_write_exact(descriptor, content, content_length) ||
      fsync(descriptor) != 0 || close(descriptor) != 0)
    goto cleanup;
  descriptor = -1;
  if (renameat(state, temporary_name, state, "portable-install-state.json") != 0 ||
      fsync(state) != 0 ||
      !keiko_coordinator_file_digest_matches(
          destination, context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256], deadline_ms))
    goto cleanup;
  result = 1;
cleanup:
  if (descriptor != -1) close(descriptor);
  if (state != -1 && temporary_name[0] != '\0') (void)unlinkat(state, temporary_name, 0);
  if (state != -1) close(state);
  if (capsule != -1) close(capsule);
  if (content != NULL) {
    memset(content, 0, content_length);
    free(content);
  }
  return result;
}

static int keiko_coordinator_restore_roots(keiko_coordinator_context *context,
                                           uint64_t deadline_ms) {
  keiko_coordinator_cutover_state state;
  const keiko_coordinator_binding *old_binding, *new_binding, *other_name;
  int result = 0;
  if (!keiko_coordinator_cutover_classify(context, deadline_ms, &state)) return 0;
  if (state.shape != KEIKO_COORDINATOR_SHAPE_INITIAL &&
      state.shape != KEIKO_COORDINATOR_SHAPE_EXCHANGED &&
      state.shape != KEIKO_COORDINATOR_SHAPE_PROMOTED &&
      state.shape != KEIKO_COORDINATOR_SHAPE_RESTORED_BACKUP)
    goto cleanup;
  old_binding = state.managed.tree == KEIKO_COORDINATOR_TREE_CURRENT
                    ? &state.managed
                    : state.candidate.tree == KEIKO_COORDINATOR_TREE_CURRENT
                          ? &state.candidate
                          : &state.backup;
  new_binding = state.managed.tree == KEIKO_COORDINATOR_TREE_CANDIDATE
                    ? &state.managed
                    : state.candidate.tree == KEIKO_COORDINATOR_TREE_CANDIDATE
                          ? &state.candidate
                          : &state.backup;
  other_name = state.shape == KEIKO_COORDINATOR_SHAPE_EXCHANGED ? &state.candidate
                                                                : &state.backup;
  if (state.shape == KEIKO_COORDINATOR_SHAPE_EXCHANGED ||
      state.shape == KEIKO_COORDINATOR_SHAPE_PROMOTED) {
    if (!keiko_coordinator_binding_named_as(&state.managed, new_binding) ||
        !keiko_coordinator_binding_named_as(other_name, old_binding) ||
        !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("restore-before-exchange") ||
        !keiko_coordinator_exchange_at(state.managed.parent, state.managed.leaf,
                                       other_name->parent, other_name->leaf) ||
        !KEIKO_COORDINATOR_CUTOVER_CHECKPOINT("restore-after-exchange") ||
        !keiko_coordinator_sync_bindings(&state.managed, other_name) ||
        !keiko_coordinator_binding_named_as(&state.managed, old_binding) ||
        !keiko_coordinator_binding_named_as(other_name, new_binding) ||
        !keiko_coordinator_binding_digest(
            old_binding, context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256], deadline_ms) ||
        !keiko_coordinator_binding_digest(
            new_binding, context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256], deadline_ms) ||
        !keiko_coordinator_binding_named_as(&state.managed, old_binding) ||
        !keiko_coordinator_binding_named_as(other_name, new_binding))
      goto cleanup;
  }
  if (state.registration == KEIKO_COORDINATOR_REGISTRATION_PREPARED &&
      !keiko_coordinator_restore_registration(context, deadline_ms))
    goto cleanup;
  if (keiko_coordinator_registration_state(context, deadline_ms) !=
          KEIKO_COORDINATOR_REGISTRATION_PREVIOUS ||
      !keiko_coordinator_binding_named_as(&state.managed, old_binding) ||
      !keiko_coordinator_binding_digest(
          old_binding, context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256], deadline_ms) ||
      !keiko_coordinator_binding_named_as(&state.managed, old_binding))
    goto cleanup;
  result = 1;
cleanup:
  keiko_coordinator_cutover_state_clear(&state);
  return result;
}

static int keiko_coordinator_restore_previous(keiko_coordinator_context *context,
                                              uint64_t deadline_ms) {
  return keiko_tree_before_deadline(deadline_ms) &&
         keiko_coordinator_append_receipt(context, "restore", "intent") &&
         keiko_coordinator_restore_roots(context, deadline_ms) &&
         keiko_coordinator_append_receipt(context, "restore", "completed");
}

static int keiko_coordinator_remove_directory_at(int parent, const char *name,
                                                 unsigned int depth,
                                                 keiko_tree_walk_budget *budget,
                                                 uint64_t deadline_ms) {
  struct stat named, opened, current;
  int descriptor = -1, result = 0;
  DIR *directory = NULL;
  struct dirent *entry;
  if (depth > KEIKO_TREE_MAX_DEPTH || !keiko_tree_before_deadline(deadline_ms) ||
      !keiko_tree_valid_component(name) ||
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISDIR(named.st_mode))
    return 0;
  descriptor = openat(parent, name,
                      O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (descriptor == -1 || fstat(descriptor, &opened) != 0 ||
      opened.st_dev != named.st_dev || opened.st_ino != named.st_ino)
    goto cleanup;
  directory = fdopendir(descriptor);
  if (directory == NULL) goto cleanup;
  descriptor = -1;
  errno = 0;
  while ((entry = readdir(directory)) != NULL) {
    struct stat child;
    int directory_fd;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!keiko_tree_before_deadline(deadline_ms) ||
        !keiko_tree_valid_component(entry->d_name) ||
        !keiko_tree_record_entry(budget, entry->d_name))
      goto cleanup;
    directory_fd = dirfd(directory);
    if (directory_fd == -1 ||
        fstatat(directory_fd, entry->d_name, &child, AT_SYMLINK_NOFOLLOW) != 0)
      goto cleanup;
    if (S_ISDIR(child.st_mode)) {
      if (!keiko_coordinator_remove_directory_at(directory_fd, entry->d_name, depth + 1u,
                                                 budget, deadline_ms))
        goto cleanup;
    } else if (S_ISREG(child.st_mode) && child.st_nlink == 1) {
      if (unlinkat(directory_fd, entry->d_name, 0) != 0) goto cleanup;
    } else {
      goto cleanup;
    }
    errno = 0;
  }
  if (errno != 0 || closedir(directory) != 0) {
    directory = NULL;
    goto cleanup;
  }
  directory = NULL;
  if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      current.st_dev != named.st_dev || current.st_ino != named.st_ino ||
      unlinkat(parent, name, AT_REMOVEDIR) != 0)
    goto cleanup;
  result = 1;
cleanup:
  if (directory != NULL) closedir(directory);
  if (descriptor != -1) close(descriptor);
  return result;
}

static int keiko_coordinator_remove_tree(const char *path, uint64_t deadline_ms) {
  char storage[KEIKO_KHP_MAX_PATH_BYTES + 1], *leaf, *separator;
  int parent = -1, result = 0;
  keiko_tree_walk_budget budget = {0, 0};
  size_t length = strlen(path);
  if (length >= sizeof(storage)) return 0;
  memcpy(storage, path, length + 1u);
  separator = strrchr(storage, '/');
  if (separator == NULL || separator == storage || separator[1] == '\0') return 0;
  leaf = separator + 1;
  *separator = '\0';
  parent = open(storage, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (parent == -1) return 0;
  result = keiko_coordinator_remove_directory_at(parent, leaf, 0u, &budget, deadline_ms);
  if (result && fsync(parent) != 0) result = 0;
  close(parent);
  return result;
}

static int keiko_coordinator_cleanup_verified(keiko_coordinator_context *context,
                                              uint64_t deadline_ms) {
  if (!keiko_coordinator_append_receipt(context, "cleanup", "intent") ||
      !keiko_coordinator_remove_tree(context->plan.field[KEIKO_KHP_BACKUP_ROOT], deadline_ms) ||
      !keiko_coordinator_remove_tree(context->plan.field[KEIKO_KHP_STAGE_ROOT], deadline_ms) ||
      !keiko_coordinator_append_receipt(context, "cleanup", "completed") ||
      !keiko_coordinator_append_receipt(context, "complete", "completed"))
    return 0;
  return 1;
}

static int keiko_coordinator_next_receipt_exists(const keiko_coordinator_context *context) {
  char path[KEIKO_KHP_MAX_PATH_BYTES + 1], suffix[64];
  struct stat status;
  if (snprintf(suffix, sizeof(suffix), "/receipts/%06u.khr",
               context->receipt_sequence + 1u) <= 0 ||
      !keiko_coordinator_join(path, sizeof(path), context->capsule, suffix)) return 1;
  if (lstat(path, &status) == 0) return 1;
  return errno != ENOENT;
}

static void keiko_coordinator_hold_runtime(keiko_coordinator_context *context) {
  int status;
  if (context->supervisor_pid <= 0) return;
  while (waitpid(context->supervisor_pid, &status, 0) < 0 && errno == EINTR) {}
  context->supervisor_pid = -1;
  if (context->supervisor_control >= 0) {
    close(context->supervisor_control);
    context->supervisor_control = -1;
  }
  if (context->supervisor_response >= 0) {
    close(context->supervisor_response);
    context->supervisor_response = -1;
  }
}

static int keiko_coordinator_engine_deadline(
    void *opaque,
    int field,
    uint64_t *deadline_ms
) {
  return keiko_coordinator_deadline(
      (keiko_coordinator_context *)opaque,
      field,
      deadline_ms
  );
}

static int keiko_coordinator_engine_emit_acceptance(void *opaque) {
  return keiko_coordinator_emit_acceptance((keiko_coordinator_context *)opaque);
}

static int keiko_coordinator_engine_wait_old_exit(void *opaque) {
  return keiko_coordinator_wait_old_exit((keiko_coordinator_context *)opaque);
}

static int keiko_coordinator_engine_promote(void *opaque, uint64_t deadline_ms) {
  return keiko_coordinator_promote((keiko_coordinator_context *)opaque, deadline_ms);
}

static int keiko_coordinator_engine_publish_registration(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_publish_registration(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_engine_start_runtime(
    void *opaque,
    uint64_t deadline_ms,
    int restoring
) {
  return keiko_coordinator_start_runtime(
      (keiko_coordinator_context *)opaque,
      deadline_ms,
      restoring
  );
}

static int keiko_coordinator_engine_wait_receipt(
    void *opaque,
    const char *kind,
    const char *outcome,
    uint64_t deadline_ms
) {
  return keiko_coordinator_wait_expected_receipt(
      (keiko_coordinator_context *)opaque,
      kind,
      outcome,
      deadline_ms
  );
}

static int keiko_coordinator_engine_next_receipt_exists(void *opaque) {
  return keiko_coordinator_next_receipt_exists((keiko_coordinator_context *)opaque);
}

static int keiko_coordinator_engine_stop_runtime(void *opaque, uint64_t deadline_ms) {
  return keiko_coordinator_stop_runtime((keiko_coordinator_context *)opaque, deadline_ms);
}

static int keiko_coordinator_engine_reconcile_stopped_runtime(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_reconcile_stopped_runtime(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_engine_stop_failed_start(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_stop_failed_start(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_engine_wait_verified_ack(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_wait_verified_ack(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_engine_cleanup_verified(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_cleanup_verified(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static int keiko_coordinator_engine_restore_previous(
    void *opaque,
    uint64_t deadline_ms
) {
  return keiko_coordinator_restore_previous(
      (keiko_coordinator_context *)opaque,
      deadline_ms
  );
}

static void keiko_coordinator_engine_hold_runtime(void *opaque) {
  keiko_coordinator_hold_runtime((keiko_coordinator_context *)opaque);
}

/* Production forward/restore transaction. All authority checks complete before this function
 * emits KHA1 and releases the parent process to exit. */
static int keiko_coordinator_execute_posix(keiko_coordinator_context *context) {
  const keiko_coordinator_engine engine = {
      context,
      keiko_coordinator_engine_deadline,
      keiko_coordinator_engine_emit_acceptance,
      keiko_coordinator_engine_wait_old_exit,
      keiko_coordinator_engine_promote,
      keiko_coordinator_engine_publish_registration,
      keiko_coordinator_engine_start_runtime,
      keiko_coordinator_engine_wait_receipt,
      keiko_coordinator_engine_next_receipt_exists,
      keiko_coordinator_engine_stop_runtime,
      keiko_coordinator_engine_reconcile_stopped_runtime,
      keiko_coordinator_engine_stop_failed_start,
      keiko_coordinator_engine_wait_verified_ack,
      keiko_coordinator_engine_cleanup_verified,
      keiko_coordinator_engine_restore_previous,
      keiko_coordinator_engine_hold_runtime};
  return keiko_coordinator_execute_engine(
      &engine,
      KEIKO_KHP_START_AT,
      KEIKO_KHP_VERIFY_AT,
      KEIKO_KHP_CLEANUP_AT
  );
}

static int keiko_coordinator_hash_file(const char *path, uint64_t deadline_ms,
                                       char output[65]) {
  int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  struct stat before, after, named;
  unsigned char buffer[64u * 1024u], digest[32];
  uint64_t total = 0;
  keiko_sha256 hash;
  int result = 0;
  if (descriptor == -1 || fstat(descriptor, &before) != 0 || !S_ISREG(before.st_mode) ||
      before.st_nlink != 1 || before.st_size < 0 ||
      (uint64_t)before.st_size > KEIKO_COORDINATOR_MAX_FILE_BYTES ||
      !keiko_sha256_init(&hash)) goto cleanup;
  for (;;) {
    ssize_t count;
    if (!keiko_tree_before_deadline(deadline_ms)) goto cleanup_hash;
    count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) goto cleanup_hash;
    if (count == 0) break;
    total += (uint64_t)count;
    if (total > (uint64_t)before.st_size ||
        !keiko_sha256_update(&hash, buffer, (size_t)count)) goto cleanup_hash;
  }
  if (fstat(descriptor, &after) != 0 || lstat(path, &named) != 0 ||
      !keiko_coordinator_same_file(&before, &after) ||
      !keiko_coordinator_same_file(&before, &named) || total != (uint64_t)before.st_size ||
      !keiko_sha256_final(&hash, digest)) goto cleanup;
  keiko_sha256_hex(digest, output);
  memset(digest, 0, sizeof(digest));
  result = 1;
  goto cleanup;
cleanup_hash:
  keiko_sha256_clear(&hash);
cleanup:
  if (descriptor != -1) close(descriptor);
  return result;
}

static int keiko_coordinator_join(char *output, size_t capacity, const char *base,
                                  const char *suffix) {
  int written = snprintf(output, capacity, "%s%s", base, suffix);
  return written > 0 && (size_t)written < capacity;
}

static int keiko_coordinator_file_digest_matches(const char *path, const char *expected,
                                                  uint64_t deadline_ms) {
  char actual[65];
  return keiko_coordinator_hash_file(path, deadline_ms, actual) && strcmp(actual, expected) == 0;
}

static int keiko_coordinator_load_plan(keiko_coordinator_context *context, int capsule_fd,
                                       const char *activation_id, uint64_t deadline_ms) {
  unsigned char *plan_content = NULL, *digest_content = NULL;
  size_t plan_length = 0, digest_length = 0;
  char actual[65];
  int result = 0;
  if (!keiko_coordinator_read_file_at(capsule_fd, "plan.khp", KEIKO_KHP_MAX_BYTES,
                                      deadline_ms, &plan_content, &plan_length) ||
      !keiko_coordinator_read_file_at(capsule_fd, "plan.sha256", 65u, deadline_ms,
                                      &digest_content, &digest_length) ||
      digest_length != 65u || digest_content[64] != '\n' ||
      memchr(digest_content, 0, 64u) != NULL) goto cleanup;
  digest_content[64] = 0;
  if (!keiko_khp_is_lower_hex((const char *)digest_content, 64u) ||
      !keiko_coordinator_hash_bytes(plan_content, plan_length, actual) ||
      strcmp(actual, (const char *)digest_content) != 0 ||
      !keiko_khp_parse(plan_content, plan_length, &context->plan) ||
      strcmp(context->plan.field[KEIKO_KHP_ACTIVATION_ID], activation_id) != 0) goto cleanup;
  memcpy(context->plan_sha256, actual, sizeof(context->plan_sha256));
  result = 1;
cleanup:
  if (plan_content != NULL) {
    memset(plan_content, 0, plan_length);
    free(plan_content);
  }
  if (digest_content != NULL) {
    memset(digest_content, 0, digest_length);
    free(digest_content);
  }
  if (!result) keiko_khp_clear(&context->plan);
  return result;
}

static int keiko_coordinator_parent_control(const keiko_coordinator_context *context,
                                            uint64_t deadline_ms) {
  char control[65];
  if (!keiko_coordinator_read_exact_deadline(STDIN_FILENO, control, sizeof(control), deadline_ms))
    return 0;
  return control[64] == '\n' && memcmp(control, context->plan_sha256, 64u) == 0;
}

static int keiko_coordinator_ui_identity(const keiko_coordinator_context *context,
                                         uint64_t deadline_ms) {
  char path[KEIKO_KHP_MAX_PATH_BYTES + 1], expected[512];
  char actual[512];
  int descriptor, written;
  ssize_t count;
  struct stat status;
  if (!keiko_coordinator_join(path, sizeof(path), context->state_dir, "/ui.pid")) return 0;
  written = snprintf(expected, sizeof(expected), "%s\n%s\n",
                     context->plan.field[KEIKO_KHP_OLD_PID],
                     context->plan.field[KEIKO_KHP_OLD_LAUNCH_ID]);
  if (written <= 0 || (size_t)written >= sizeof(expected) ||
      !keiko_tree_before_deadline(deadline_ms)) return 0;
  descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (descriptor == -1 || fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_nlink != 1 || status.st_size != written) {
    if (descriptor != -1) close(descriptor);
    return 0;
  }
  count = read(descriptor, actual, sizeof(actual));
  close(descriptor);
  return count == written && memcmp(actual, expected, (size_t)written) == 0;
}

static int keiko_coordinator_registration_matches(const keiko_coordinator_context *context,
                                                  int capsule_fd, uint64_t deadline_ms) {
  char registration[KEIKO_KHP_MAX_PATH_BYTES + 1], digest[65];
  unsigned char *snapshot = NULL;
  size_t snapshot_length = 0;
  int result = 0;
  if (strcmp(context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_STATE], "present") != 0 ||
      !keiko_coordinator_join(registration, sizeof(registration), context->state_dir,
                              "/portable-install-state.json") ||
      !keiko_coordinator_file_digest_matches(
          registration, context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256], deadline_ms) ||
      !keiko_coordinator_read_file_at(capsule_fd, "registration.previous", 64u * 1024u,
                                      deadline_ms, &snapshot, &snapshot_length) ||
      !keiko_coordinator_hash_bytes(snapshot, snapshot_length, digest) ||
      strcmp(digest, context->plan.field[KEIKO_KHP_PREVIOUS_REGISTRATION_SHA256]) != 0)
    goto cleanup;
  free(snapshot);
  snapshot = NULL;
  if (!keiko_coordinator_read_file_at(capsule_fd, "registration.next", 64u * 1024u,
                                      deadline_ms, &snapshot, &snapshot_length) ||
      !keiko_coordinator_hash_bytes(snapshot, snapshot_length, digest) ||
      strcmp(digest, context->plan.field[KEIKO_KHP_PREPARED_REGISTRATION_SHA256]) != 0)
    goto cleanup;
  result = 1;
cleanup:
  if (snapshot != NULL) {
    memset(snapshot, 0, snapshot_length);
    free(snapshot);
  }
  return result;
}

static int keiko_coordinator_probe_monitor(const char *supervisor, uint64_t deadline_ms) {
  pid_t child = -1;
  posix_spawn_file_actions_t actions;
  char *const arguments[] = {(char *)supervisor, (char *)"--probe-monitor", NULL};
  char *const environment[] = {NULL};
  int status = 0, initialized = 0;
  uint64_t probe_deadline = keiko_tree_now_ms() + KEIKO_COORDINATOR_PROBE_MS;
  if (probe_deadline > deadline_ms) probe_deadline = deadline_ms;
  if (posix_spawn_file_actions_init(&actions) != 0) return 0;
  initialized = 1;
  (void)posix_spawn_file_actions_addclose(&actions, STDIN_FILENO);
  (void)posix_spawn_file_actions_addclose(&actions, 3);
  if (posix_spawn(&child, supervisor, &actions, NULL, arguments, environment) != 0) goto cleanup;
  while (keiko_tree_before_deadline(probe_deadline)) {
    pid_t waited = waitpid(child, &status, WNOHANG);
    if (waited == child) {
      child = -1;
      if (initialized) posix_spawn_file_actions_destroy(&actions);
      return WIFEXITED(status) && WEXITSTATUS(status) == 0;
    }
    if (waited < 0 && errno != EINTR) break;
    usleep(10000);
  }
cleanup:
  if (child > 0) {
    (void)kill(child, SIGKILL);
    while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  }
  if (initialized) posix_spawn_file_actions_destroy(&actions);
  return 0;
}

static int keiko_coordinator_artifacts_match(const keiko_coordinator_context *context,
                                             uint64_t deadline_ms) {
  char copied_supervisor[KEIKO_KHP_MAX_PATH_BYTES + 1], tree_digest[65];
  uint64_t remaining, tree_deadline;
  if (!keiko_coordinator_join(copied_supervisor, sizeof(copied_supervisor), context->capsule,
                              "/runtime-supervisor")) return 0;
  remaining = context->plan.field[KEIKO_KHP_OLD_EXIT_AT] == NULL
                  ? 0
                  : strtoull(context->plan.field[KEIKO_KHP_OLD_EXIT_AT], NULL, 10);
  if (remaining <= keiko_coordinator_wall_ms()) return 0;
  tree_deadline = keiko_tree_now_ms() + (remaining - keiko_coordinator_wall_ms());
  if (tree_deadline > deadline_ms) tree_deadline = deadline_ms;
  return keiko_coordinator_file_digest_matches(
             context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER],
             context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256], deadline_ms) &&
         keiko_coordinator_file_digest_matches(
             context->plan.field[KEIKO_KHP_CANDIDATE_SUPERVISOR],
             context->plan.field[KEIKO_KHP_CANDIDATE_SUPERVISOR_SHA256], deadline_ms) &&
         keiko_coordinator_file_digest_matches(
             copied_supervisor, context->plan.field[KEIKO_KHP_CURRENT_SUPERVISOR_SHA256],
             deadline_ms) &&
         keiko_tree_hash_posix(context->plan.field[KEIKO_KHP_MANAGED_ROOT], tree_deadline,
                               tree_digest) &&
         strcmp(tree_digest, context->plan.field[KEIKO_KHP_CURRENT_TREE_SHA256]) == 0 &&
         keiko_tree_hash_posix(context->plan.field[KEIKO_KHP_CANDIDATE_ROOT], tree_deadline,
                               tree_digest) &&
         strcmp(tree_digest, context->plan.field[KEIKO_KHP_CANDIDATE_TREE_SHA256]) == 0 &&
         keiko_coordinator_probe_monitor(copied_supervisor, deadline_ms);
}

static void keiko_coordinator_clear(keiko_coordinator_context *context) {
  if (context->supervisor_control >= 0) close(context->supervisor_control);
  if (context->supervisor_response >= 0) close(context->supervisor_response);
  if (context->start_gate >= 0) close(context->start_gate);
  keiko_khp_clear(&context->plan);
  memset(context, 0, sizeof(*context));
  context->supervisor_pid = -1;
  context->supervisor_control = -1;
  context->supervisor_response = -1;
  context->start_gate = -1;
}

/* Returns 1 only after every pre-exit authority has been revalidated. KHA1 is emitted later by
 * the executor so no mutation can precede the complete authority check. */
static int keiko_coordinator_prepare_posix(keiko_coordinator_context *context,
                                          const char *activation_id,
                                          const char *executable) {
  const char *state = getenv("KEIKO_STATE_DIR");
  char canonical_state[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char canonical_executable[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char expected_executable[KEIKO_KHP_MAX_PATH_BYTES + 1];
  struct stat capsule_status, managed_status, stage_status, backup_status;
  int capsule_fd = -1;
  uint64_t deadline = keiko_tree_now_ms() + KEIKO_COORDINATOR_MAX_CONTROL_MS;
  uint64_t old_exit_wall, wall_now;
  int result = 0;
  memset(context, 0, sizeof(*context));
  context->supervisor_pid = -1;
  context->supervisor_control = -1;
  context->supervisor_response = -1;
  context->start_gate = -1;
  if (state == NULL || !keiko_khp_is_absolute_canonical_path(state) ||
      realpath(state, canonical_state) == NULL || strcmp(state, canonical_state) != 0 ||
      realpath(executable, canonical_executable) == NULL ||
      !keiko_coordinator_join(context->capsule, sizeof(context->capsule), state,
                              "/updates/handoff/") ||
      strlen(context->capsule) + strlen(activation_id) + 1u > sizeof(context->capsule))
    return 0;
  strcat(context->capsule, activation_id);
  memcpy(context->state_dir, state, strlen(state) + 1u);
  if (!keiko_coordinator_join(expected_executable, sizeof(expected_executable), context->capsule,
                              "/coordinator") ||
      strcmp(canonical_executable, expected_executable) != 0) return 0;
  capsule_fd = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (capsule_fd == -1 || fstat(capsule_fd, &capsule_status) != 0 ||
      !S_ISDIR(capsule_status.st_mode) || capsule_status.st_uid != geteuid() ||
      (capsule_status.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      !keiko_coordinator_load_plan(context, capsule_fd, activation_id, deadline)) goto cleanup;
  wall_now = keiko_coordinator_wall_ms();
  if (!keiko_khp_decimal_value(context->plan.field[KEIKO_KHP_OLD_EXIT_AT],
                               UINT64_C(9007199254740991), &old_exit_wall) ||
      old_exit_wall <= wall_now) goto cleanup;
  context->old_exit_deadline = keiko_tree_now_ms() + (old_exit_wall - wall_now);
  if (context->old_exit_deadline > deadline) context->old_exit_deadline = deadline;
  if (
      (uint64_t)getppid() != strtoull(context->plan.field[KEIKO_KHP_OLD_PID], NULL, 10) ||
      !keiko_coordinator_parent_control(context, deadline) ||
      !keiko_coordinator_ui_identity(context, deadline) ||
      !keiko_coordinator_registration_matches(context, capsule_fd, deadline) ||
      lstat(context->plan.field[KEIKO_KHP_MANAGED_ROOT], &managed_status) != 0 ||
      lstat(context->plan.field[KEIKO_KHP_STAGE_ROOT], &stage_status) != 0 ||
      managed_status.st_dev != stage_status.st_dev ||
      lstat(context->plan.field[KEIKO_KHP_BACKUP_ROOT], &backup_status) == 0 || errno != ENOENT ||
      !keiko_coordinator_file_digest_matches(
          canonical_executable, context->plan.field[KEIKO_KHP_CURRENT_LAUNCHER_SHA256], deadline) ||
      !keiko_coordinator_artifacts_match(context, deadline)) goto cleanup;
  result = 1;
cleanup:
  if (capsule_fd != -1) close(capsule_fd);
  if (!result) keiko_coordinator_clear(context);
  return result;
}

static int keiko_coordinator_prepare_resume_posix(keiko_coordinator_context *context,
                                                  const char *activation_id,
                                                  const char *executable, int restoring) {
  const char *state = getenv("KEIKO_STATE_DIR");
  char canonical_state[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char canonical_executable[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char expected_executable[KEIKO_KHP_MAX_PATH_BYTES + 1];
  char gate[65];
  struct stat capsule_status;
  int capsule_fd = -1, result = 0;
  uint64_t deadline = keiko_tree_now_ms() + KEIKO_COORDINATOR_MAX_CONTROL_MS;
  memset(context, 0, sizeof(*context));
  context->supervisor_pid = -1;
  context->supervisor_control = -1;
  context->supervisor_response = -1;
  context->start_gate = -1;
  if (state == NULL || !keiko_khp_is_absolute_canonical_path(state) ||
      realpath(state, canonical_state) == NULL || strcmp(state, canonical_state) != 0 ||
      realpath(executable, canonical_executable) == NULL ||
      !keiko_coordinator_join(context->capsule, sizeof(context->capsule), state,
                              "/updates/handoff/") ||
      strlen(context->capsule) + strlen(activation_id) + 1u > sizeof(context->capsule))
    return 0;
  strcat(context->capsule, activation_id);
  memcpy(context->state_dir, state, strlen(state) + 1u);
  capsule_fd = open(context->capsule, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (capsule_fd == -1 || fstat(capsule_fd, &capsule_status) != 0 ||
      !S_ISDIR(capsule_status.st_mode) || capsule_status.st_uid != geteuid() ||
      (capsule_status.st_mode & (S_IWGRP | S_IWOTH)) != 0 ||
      !keiko_coordinator_load_plan(context, capsule_fd, activation_id, deadline) ||
      !keiko_coordinator_deadline(context, KEIKO_KHP_START_AT, &deadline) ||
      !keiko_coordinator_active_path(context,
                                     context->plan.field[KEIKO_KHP_CANDIDATE_LAUNCHER],
                                     expected_executable, sizeof(expected_executable)) ||
      strcmp(canonical_executable, expected_executable) != 0 ||
      !keiko_coordinator_file_digest_matches(
          canonical_executable,
          context->plan.field[restoring ? KEIKO_KHP_CURRENT_LAUNCHER_SHA256
                                        : KEIKO_KHP_CANDIDATE_LAUNCHER_SHA256],
          deadline) ||
      !keiko_coordinator_read_exact_deadline(KEIKO_COORDINATOR_START_GATE_FD, gate,
                                             sizeof(gate), deadline) ||
      gate[64] != '\n' || memcmp(gate, context->plan_sha256, 64u) != 0)
    goto cleanup;
  close(KEIKO_COORDINATOR_START_GATE_FD);
  result = 1;
cleanup:
  if (capsule_fd != -1) close(capsule_fd);
  if (!result) keiko_coordinator_clear(context);
  return result;
}

#else

#include "keiko-portable-update-coordinator-windows.h"

#endif

#endif
