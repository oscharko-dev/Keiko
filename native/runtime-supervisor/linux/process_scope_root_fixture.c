/* An actual namespaced app root checks its outer identity and kernel liveness port. */
#define _GNU_SOURCE
#include "../macos/keiko_runtime_protocol.h"
#include <assert.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <limits.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdio.h>

static void read_packet(unsigned char bytes[20], uint16_t kind) {
  assert(recv(7, bytes, 20, MSG_TRUNC) == 20);
  assert(memcmp(bytes, "KPI1", 4) == 0 && read_u16(bytes + 4) == 1);
  assert(read_u16(bytes + 6) == kind && read_u32(bytes + 8) == 8);
}

static void probe(pid_t pid, uint32_t expected) {
  unsigned char request[16] = {'K','P','I','1',1,0,2,0,4,0,0,0,0,0,0,0}, response[20];
  write_u32(request + 12, (uint32_t)pid);
  assert(send(7, request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
  read_packet(response, 3);
  assert(read_u32(response + 12) == (uint32_t)pid);
  assert(read_u32(response + 16) == expected);
}

static void conditional_owner(int descriptor, const struct stat *expected, uint32_t status) {
  unsigned char request[36] = {'K','P','I','1',1,0,6,0,24,0,0,0}, metadata[44];
  write_u32(request + 12, (uint32_t)descriptor);
  write_u32(request + 32, (uint32_t)expected->st_mode);
  for (size_t i = 0; i < 8; ++i) {
    request[16 + i] = (unsigned char)((uint64_t)expected->st_dev >> (8u * i));
    request[24 + i] = (unsigned char)((uint64_t)expected->st_ino >> (8u * i));
  }
  assert(send(7, request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
  assert(recv(7, metadata, sizeof(metadata), MSG_TRUNC) == sizeof(metadata));
  assert(memcmp(metadata, "KPI1", 4) == 0 && read_u16(metadata + 4) == 1 &&
    read_u16(metadata + 6) == 7 && read_u32(metadata + 8) == 32 &&
    read_u32(metadata + 12) == (uint32_t)descriptor && read_u32(metadata + 16) == status);
  if (status == 3) {
    for (size_t i = 20; i < sizeof(metadata); ++i) assert(metadata[i] == 0);
    return;
  }
  assert(status == 1 && read_u32(metadata + 20) == (uint32_t)geteuid());
  assert(read_u32(metadata + 24) == (uint32_t)expected->st_mode);
  for (size_t i = 0; i < 8; ++i) {
    assert(metadata[28 + i] == request[16 + i]);
    assert(metadata[36 + i] == request[24 + i]);
  }
}

static void verify_reused_descriptor(pid_t outer) {
  FILE *first = tmpfile(), *second = tmpfile();
  assert(first != NULL && second != NULL);
  int descriptor = fileno(first), replacement = fileno(second);
  struct stat old_identity, new_identity;
  assert(fstat(descriptor, &old_identity) == 0 && fstat(replacement, &new_identity) == 0);
  assert(old_identity.st_dev != new_identity.st_dev || old_identity.st_ino != new_identity.st_ino);
  assert(fclose(first) == 0 && dup2(replacement, descriptor) == descriptor);
  conditional_owner(descriptor, &old_identity, 3);
  conditional_owner(descriptor, &new_identity, 1);
  probe(outer, 1);
  assert(close(descriptor) == 0 && fclose(second) == 0);
}

int main(int argc, char **argv) {
  unsigned char identity[20];
  assert(argc == 2);
  read_packet(identity, 1);
  pid_t outer = (pid_t)read_u32(identity + 12), owner = (pid_t)read_u32(identity + 16);
  assert(getpid() == 2 && outer > 2 && owner > 2 && owner != outer);
  /* These outer PIDs cannot be observed through this app's local kill namespace. */
  errno = 0;
  assert(kill(owner, 0) == -1 && errno == ESRCH);
  probe(owner, 1);
  probe(outer, 1);
  probe(INT_MAX, 2);
  int directory = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat entry;
  assert(directory >= 0 && fstat(directory, &entry) == 0 && entry.st_uid == 65534u);
  unsigned char request[16] = {'K','P','I','1',1,0,4,0,4,0,0,0}, metadata[44];
  write_u32(request + 12, (uint32_t)directory);
  assert(send(7, request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
  assert(recv(7, metadata, sizeof(metadata), MSG_TRUNC) == sizeof(metadata));
  assert(memcmp(metadata, "KPI1", 4) == 0 && read_u16(metadata + 4) == 1 &&
    read_u16(metadata + 6) == 5 && read_u32(metadata + 8) == 32 &&
    read_u32(metadata + 12) == (uint32_t)directory && read_u32(metadata + 16) == 1 &&
    read_u32(metadata + 20) == 0 && read_u32(metadata + 24) == (uint32_t)entry.st_mode);
  for (size_t i = 0; i < 8; ++i) {
    assert(metadata[28 + i] == (unsigned char)((uint64_t)entry.st_dev >> (8u * i)));
    assert(metadata[36 + i] == (unsigned char)((uint64_t)entry.st_ino >> (8u * i)));
  }
  assert(close(directory) == 0);
  assert(send(7, request, sizeof(request), MSG_NOSIGNAL) == sizeof(request));
  assert(recv(7, metadata, sizeof(metadata), MSG_TRUNC) == sizeof(metadata));
  assert(read_u32(metadata + 16) == 2);
  for (size_t i = 20; i < sizeof(metadata); ++i) assert(metadata[i] == 0);
  if (strcmp(argv[1], "foreign") == 0) {
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
      unsigned char foreign[16] = {'K','P','I','1',1,0,2,0,4,0,0,0}, refused[20];
      write_u32(foreign + 12, (uint32_t)owner);
      assert(send(7, foreign, sizeof(foreign), MSG_NOSIGNAL) == sizeof(foreign));
      assert(recv(7, refused, sizeof(refused), 0) == 0);
      _exit(0);
    }
    int status;
    assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    assert(write_exact(STDOUT_FILENO, "REFUSED\n", 8));
    for (;;) pause();
  }
  if (strcmp(argv[1], "stale") == 0) verify_reused_descriptor(outer);
  else assert(strcmp(argv[1], "valid") == 0);
  assert(write_exact(STDOUT_FILENO, "SCOPE\n", 6));
  close(7);
  for (;;) pause();
}
