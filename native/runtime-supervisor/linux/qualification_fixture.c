#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/sched.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static void require(int condition) { if (!condition) _exit(90); }

static void write_all(int descriptor, const void *value, size_t length) {
  const char *bytes = value;
  while (length > 0) {
    ssize_t count = write(descriptor, bytes, length);
    if (count < 0 && errno == EINTR) continue;
    require(count > 0);
    bytes += count;
    length -= (size_t)count;
  }
}

static pid_t kernel_pid(const char *field) {
  FILE *file = fopen("/proc/self/status", "r");
  require(file != NULL);
  char line[256];
  pid_t result = -1;
  while (fgets(line, sizeof(line), file) != NULL) {
    if (strncmp(line, field, strlen(field)) == 0) {
      char *end;
      long value = strtol(line + strlen(field), &end, 10);
      require(end != line + strlen(field) && value > 0 && value <= 2147483647);
      result = (pid_t)value;
      break;
    }
  }
  require(fclose(file) == 0 && result > 0);
  return result;
}

static void notice(char role, pid_t pid) {
  char line[40];
  int size = snprintf(line, sizeof(line), "%c:%ld\n", role, (long)pid);
  require(size > 0 && (size_t)size < sizeof(line));
  write_all(STDOUT_FILENO, line, (size_t)size);
}

static void remain(void) { for (;;) pause(); }

static void namespace_mapping(const char *field, const char *value) {
  char path[80];
  int size = snprintf(path, sizeof(path), "/proc/self/%s", field);
  require(size > 0 && (size_t)size < sizeof(path));
  int descriptor = open(path, O_WRONLY | O_CLOEXEC);
  require(descriptor >= 0);
  write_all(descriptor, value, strlen(value));
  require(close(descriptor) == 0);
}

static void nested_namespace(void) {
  uid_t uid = getuid(); gid_t gid = getgid();
  require(unshare(CLONE_NEWUSER | CLONE_NEWPID) == 0);
  char setting[16] = {0};
  int descriptor = open("/proc/self/setgroups", O_RDONLY | O_CLOEXEC);
  require(descriptor >= 0 && read(descriptor, setting, sizeof(setting) - 1u) > 0);
  require(close(descriptor) == 0);
  if (strncmp(setting, "allow", 5) == 0) namespace_mapping("setgroups", "deny\n");
  else require(strncmp(setting, "deny", 4) == 0);
  char mapping[80];
  snprintf(mapping, sizeof(mapping), "%lu %lu 1\n", (unsigned long)uid, (unsigned long)uid);
  namespace_mapping("uid_map", mapping);
  snprintf(mapping, sizeof(mapping), "%lu %lu 1\n", (unsigned long)gid, (unsigned long)gid);
  namespace_mapping("gid_map", mapping);
  pid_t child = fork();
  require(child >= 0);
  if (child > 0) remain();
  require(getpid() == 1);
  notice('N', kernel_pid("Pid:"));
  child = fork();
  require(child >= 0);
  if (child == 0) notice('L', kernel_pid("Pid:"));
  remain();
}

static void assert_runtime_boundaries(void) {
  require(fcntl(3, F_GETFD) == -1 && errno == EBADF);
  require(fcntl(4, F_GETFD) == -1 && errno == EBADF);
  require(getuid() != 0 && getuid() == geteuid() && getgid() == getegid());
  struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct values[2] = {{0}, {0}};
  require(syscall(SYS_capget, &header, values) == 0);
  for (size_t i = 0; i < 2; ++i)
    require(values[i].effective == 0 && values[i].permitted == 0 && values[i].inheritable == 0);
  for (int cap = 0; cap < 64; ++cap) {
    int value = prctl(PR_CAPBSET_READ, cap, 0, 0, 0);
    if (value < 0) { require(errno == EINVAL); break; }
    require(value == 0);
  }
  require(prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) == 1);
  require(ptrace(PTRACE_ATTACH, 1, NULL, NULL) == -1 && errno == EPERM);
}

int main(int argc, char **argv) {
  assert_runtime_boundaries();
  require(argc == 3);
  if (strcmp(argv[1], "--resume-update") == 0) {
    require(getenv("KEIKO_STATE_DIR") != NULL);
  } else {
    require(strcmp(argv[1], "--qualified") == 0);
    require(getenv("KEIKO_ALPHA") != NULL && strcmp(getenv("KEIKO_ALPHA"), "one") == 0);
  }
  notice('I', kernel_pid("PPid:"));
  notice('R', kernel_pid("Pid:"));
  pid_t middle = fork();
  require(middle >= 0);
  if (middle == 0) {
    require(setsid() >= 0);
    pid_t detached = fork();
    require(detached >= 0);
    if (detached > 0) _exit(0);
    notice('D', kernel_pid("Pid:"));
    remain();
  }
  nested_namespace();
}
