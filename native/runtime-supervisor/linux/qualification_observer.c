#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static int held_init = -1;
static int stopped_init;
static int held_supervisor = -1;
static int stopped_supervisor;

static void cleanup_stopped_init(void) {
  if (stopped_init && held_init >= 0) {
    (void)syscall(SYS_pidfd_send_signal, held_init, SIGCONT, NULL, 0u);
    (void)syscall(SYS_pidfd_send_signal, held_init, SIGKILL, NULL, 0u);
  }
  if (stopped_supervisor && held_supervisor >= 0) {
    (void)syscall(SYS_pidfd_send_signal, held_supervisor, SIGCONT, NULL, 0u);
    (void)syscall(SYS_pidfd_send_signal, held_supervisor, SIGKILL, NULL, 0u);
  }
}

static unsigned long long now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
  return (unsigned long long)value.tv_sec * 1000u + (unsigned long long)value.tv_nsec / 1000000u;
}

static int init_is_stopped(pid_t pid) {
  char path[80], line[256];
  if (snprintf(path, sizeof(path), "/proc/%ld/status", (long)pid) <= 0) return 0;
  FILE *file = fopen(path, "r");
  if (file == NULL) return 0;
  int stopped = 0;
  while (fgets(line, sizeof(line), file) != NULL) {
    if (strncmp(line, "State:", 6) != 0) continue;
    char *state = line + 6;
    while (*state == ' ' || *state == '\t') ++state;
    stopped = *state == 'T' || *state == 't';
    break;
  }
  return fclose(file) == 0 && stopped;
}

static int stop_init(pid_t pid, struct pollfd *reference, int *stopped) {
  unsigned long long started = now_ms(), deadline = started + 1000u;
  if (started == 0 || deadline <= started ||
      syscall(SYS_pidfd_send_signal, reference->fd, SIGSTOP, NULL, 0u) != 0)
    return 0;
  *stopped = 1;
  for (;;) {
    unsigned long long now = now_ms();
    if (now == 0 || now < started || now >= deadline) return 0;
    if (poll(reference, 1, 0) != 0) return 0;
    if (init_is_stopped(pid) && poll(reference, 1, 0) == 0) {
      now = now_ms();
      return now >= started && now < deadline;
    }
    if (poll(NULL, 0, 1) < 0 && errno != EINTR) return 0;
  }
}

int main(int argc, char **argv) {
  if (argc != 6 && argc != 7) return 2;
  int count = argc - 1;
  struct pollfd held[6];
  pid_t pids[6];
  for (int i = 0; i < count; ++i) {
    char *end;
    long pid = strtol(argv[i + 1], &end, 10);
    if (*end != '\0' || pid <= 0 || pid > 2147483647) return 3;
    pids[i] = (pid_t)pid;
    held[i] = (struct pollfd){(int)syscall(SYS_pidfd_open, (pid_t)pid, 0u), POLLIN, 0};
    if (held[i].fd < 0) return 4;
    for (int j = 0; j < i; ++j) if (pids[j] == pids[i]) return 5;
  }
  int ready = poll(held, (nfds_t)count, 0);
  if (ready != 0) return 6;
  held_init = held[0].fd;
  held_supervisor = count == 6 ? held[5].fd : -1;
  if (atexit(cleanup_stopped_init) != 0) return 16;
  if (write(STDOUT_FILENO, "H", 1) != 1) return 7;
  char command;
  for (;;) {
    if (read(STDIN_FILENO, &command, 1) != 1) return 8;
    if (command == 'S') {
      if (!stop_init(pids[0], &held[0], &stopped_init) || write(STDOUT_FILENO, "H", 1) != 1) return 17;
      continue;
    }
    if (command == 'A') {
      if (count != 6 || !stop_init(pids[5], &held[5], &stopped_supervisor) ||
          write(STDOUT_FILENO, "H", 1) != 1) return 21;
      continue;
    }
    if (command == 'B') {
      if (!stopped_supervisor ||
          syscall(SYS_pidfd_send_signal, held_supervisor, SIGCONT, NULL, 0u) != 0) return 22;
      stopped_supervisor = 0;
      if (write(STDOUT_FILENO, "H", 1) != 1) return 23;
      continue;
    }
    if (command == 'U') {
      if (!stopped_init || syscall(SYS_pidfd_send_signal, held[0].fd, SIGCONT, NULL, 0u) != 0)
        return 18;
      stopped_init = 0;
      if (write(STDOUT_FILENO, "H", 1) != 1) return 19;
      continue;
    }
    if (command == 'T') {
      if (syscall(SYS_pidfd_send_signal, held[1].fd, SIGTERM, NULL, 0u) != 0 ||
          write(STDOUT_FILENO, "H", 1) != 1) return 15;
      continue;
    }
    if (command != 'P') break;
    if (poll(held, (nfds_t)count, 0) != 0 || write(STDOUT_FILENO, "H", 1) != 1) return 14;
  }
  if (command == 'X') {
    cleanup_stopped_init();
    stopped_init = 0;
    stopped_supervisor = 0;
  } else if (command != 'C' && command != 'Z') return 8;
  unsigned long long started = now_ms(), deadline = started + 5000u;
  if (started == 0 || deadline <= started) return 9;
  for (;;) {
    unsigned long long now = now_ms();
    if (now == 0 || now < started || now >= deadline) return 13;
    ready = poll(held, (nfds_t)count, 1);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) return 10;
    int exited = 0;
    for (int i = 0; i < count; ++i) {
      if ((held[i].revents & POLLIN) != 0) exited += 1;
      else if (held[i].revents != 0) return 11;
    }
    if (exited == count) {
      stopped_init = 0;
      stopped_supervisor = 0;
      for (int i = 0; i < count; ++i) close(held[i].fd);
      return write(STDOUT_FILENO, "R", 1) == 1 ? 0 : 12;
    }
    if (command == 'Z') return 20;
  }
}
