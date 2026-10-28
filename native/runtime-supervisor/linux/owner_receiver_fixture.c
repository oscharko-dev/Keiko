/* Deterministic receiver negatives use the actual existing-launcher owner implementation. */
#define _GNU_SOURCE
#include <assert.h>
#include <dirent.h>
#include <stdint.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <time.h>

static uint64_t clock_offset;
static int late_receive;
static int fixture_clock(clockid_t clock, struct timespec *value);
static ssize_t fixture_receive(int descriptor, struct msghdr *message, int flags);
#define clock_gettime fixture_clock
#define recvmsg fixture_receive
#define main keiko_portable_launcher_product_main
#include "../../portable-launcher/keiko-portable-launcher.c"
#undef main
#undef recvmsg
#undef clock_gettime

static int fixture_clock(clockid_t clock, struct timespec *value) {
  int result = clock_gettime(clock, value);
  if (result == 0 && clock == CLOCK_MONOTONIC) value->tv_sec += (time_t)(clock_offset / 1000u);
  return result;
}

static ssize_t fixture_receive(int descriptor, struct msghdr *message, int flags) {
  ssize_t result = recvmsg(descriptor, message, flags);
  if (late_receive && result >= 0) clock_offset += 10000u;
  return result;
}

static int descriptor_count(void) {
  DIR *directory = opendir("/proc/self/fd");
  assert(directory != NULL);
  int count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (entry->d_name[0] != '.') ++count;
  }
  assert(closedir(directory) == 0);
  return count;
}

static pid_t create_root(void) {
  int ready[2];
  assert(pipe(ready) == 0);
  pid_t owner = getpid(), root = fork();
  assert(root >= 0);
  if (root == 0) {
    close(ready[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 || getppid() != owner ||
        write(ready[1], "R", 1) != 1) _exit(126);
    close(ready[1]);
    if (syscall(SYS_close_range, 3u, UINT_MAX, 0u) != 0) _exit(126);
    for (;;) pause();
  }
  close(ready[1]);
  char byte;
  assert(read(ready[0], &byte, 1) == 1 && byte == 'R');
  close(ready[0]);
  return root;
}

static void send_identity(int descriptor, const char *mode, pid_t root, int reference) {
  unsigned char bytes[16] = {'K','R','I','1',1,0,1,0,4,0,0,0,0,0,0,0};
  write_u32(bytes + 12, (uint32_t)root);
  if (strcmp(mode, "magic") == 0) bytes[0] = 'X';
  if (strcmp(mode, "version") == 0) bytes[4] = 2;
  if (strcmp(mode, "kind") == 0) bytes[6] = 2;
  if (strcmp(mode, "length") == 0) bytes[8] = 8;
  if (strcmp(mode, "zero-pid") == 0) write_u32(bytes + 12, 0);
  if (strcmp(mode, "owner-pid") == 0) write_u32(bytes + 12, (uint32_t)getppid());
  int rights = strcmp(mode, "no-rights") == 0 ? 0 : strcmp(mode, "two-rights") == 0 ? 2 :
                 strcmp(mode, "truncated-rights") == 0 ? 3 : 1;
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int) * 3)]; } ancillary = {0};
  struct iovec payload = {bytes, strcmp(mode, "short") == 0 ? 15u : sizeof(bytes)};
  struct msghdr message = {.msg_iov = &payload, .msg_iovlen = 1};
  if (rights > 0) {
    message.msg_control = ancillary.bytes;
    message.msg_controllen = CMSG_SPACE(sizeof(int) * (size_t)rights);
    struct cmsghdr *header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int) * (size_t)rights);
    for (int index = 0; index < rights; ++index)
      memcpy(CMSG_DATA(header) + (size_t)index * sizeof(int), &reference, sizeof(reference));
  }
  assert(sendmsg(descriptor, &message, MSG_NOSIGNAL) == (ssize_t)payload.iov_len);
}

static void producer(int identity, int control, const char *mode) {
  pid_t root = create_root();
  pid_t other = strcmp(mode, "mismatched-pid") == 0 ? create_root() : -1;
  int reference = (int)syscall(SYS_pidfd_open, root, 0u), status;
  assert(reference >= 0);
  int pipe_handle[2] = {-1, -1};
  if (strcmp(mode, "empty-pipe") == 0) {
    assert(pipe(pipe_handle) == 0);
    close(reference); reference = pipe_handle[0];
  }
  int retired = strcmp(mode, "retired") == 0;
  if (retired) {
    assert(kill(root, SIGKILL) == 0 && waitpid(root, &status, 0) == root);
  }
  if (strcmp(mode, "eof") != 0) send_identity(identity, mode, other > 0 ? other : root, reference);
  close(identity); close(reference);
  char release;
  assert(read(control, &release, 1) == 1 && release == 'X');
  if (!retired) assert(kill(root, SIGKILL) == 0 && waitpid(root, &status, 0) == root);
  if (other > 0) assert(kill(other, SIGKILL) == 0 && waitpid(other, &status, 0) == other);
  if (pipe_handle[1] >= 0) close(pipe_handle[1]);
  close(control);
  _exit(0);
}

static void parent_race_child(int gate, int report, int owner_handle) {
  int signal_number = -1;
  assert(prctl(PR_GET_PDEATHSIG, &signal_number, 0, 0, 0) == 0 && signal_number == 0);
  char release;
  assert(read(gate, &release, 1) == 1 && release == 'G');
  int accepted = keiko_bind_parent_death(owner_handle);
  char result = accepted ? 'Y' : 'N';
  assert(write(report, &result, 1) == 1);
  _exit(accepted ? 1 : 0);
}

static int proc_coordinate_controls(void) {
  assert(keiko_owner_proc_scalar("NSpid:\t23\n", "NSpid:", 23));
  assert(!keiko_owner_proc_scalar("NSpid:\t23\t23\n", "NSpid:", 23));
  assert(!keiko_owner_proc_scalar("NSpid:\t23\nNSpid:\t23\n", "NSpid:", 23));
  assert(!keiko_owner_proc_scalar("NSpid:\t23x\n", "NSpid:", 23));
  assert(!keiko_owner_proc_scalar("NSpid:\t-1\n", "NSpid:", 23));
  assert(!keiko_owner_proc_scalar("NSpid:\t24\n", "NSpid:", 23));
  char path[] = "/tmp/keiko-owner-proc.XXXXXX", content[256];
  int descriptor = mkstemp(path);
  assert(descriptor >= 0 && write(descriptor, "Pid:\t23\n", 8) == 8);
  assert(close(descriptor) == 0);
  assert(!keiko_owner_read_proc(path, content, sizeof(content), keiko_tree_now_ms() + 5000u));
  assert(unlink(path) == 0);
  return 0;
}

static int parent_death_race(void) {
  int gate[2], report[2], status;
  assert(prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0);
  assert(pipe(gate) == 0 && pipe(report) == 0);
  pid_t parent = getpid(), owner = fork();
  assert(owner >= 0);
  if (owner == 0) {
    assert(prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) == 0 && getppid() == parent);
    int reference = (int)syscall(SYS_pidfd_open, getpid(), 0u);
    assert(reference >= 0);
    pid_t child = fork();
    assert(child >= 0);
    if (child == 0) {
      close(gate[1]); close(report[0]);
      parent_race_child(gate[0], report[1], reference);
    }
    assert(write(report[1], &child, sizeof(child)) == sizeof(child));
    for (;;) pause();
  }
  close(gate[0]); close(report[1]);
  pid_t child;
  assert(read(report[0], &child, sizeof(child)) == sizeof(child));
  int reference = (int)syscall(SYS_pidfd_open, child, 0u);
  assert(reference >= 0 && kill(owner, SIGKILL) == 0 && waitpid(owner, &status, 0) == owner);
  struct pollfd held = {reference, POLLIN, 0};
  assert(poll(&held, 1, 0) == 0 && write(gate[1], "G", 1) == 1);
  char refused;
  assert(read(report[0], &refused, 1) == 1 && refused == 'N');
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  assert(poll(&held, 1, 0) == 1 && (held.revents & POLLIN) != 0);
  close(reference); close(gate[1]); close(report[0]);
  return 0;
}

int main(int argc, char **argv) {
  assert(argc == 2);
  if (strcmp(argv[1], "--proc-coordinates") == 0) return proc_coordinate_controls();
  if (strcmp(argv[1], "--parent-race") == 0) return parent_death_race();
  if (strcmp(argv[1], "--owner-report") == 0) {
    assert(send_error(6));
    return 1;
  }
  if (strcmp(argv[1], "--gate-root") == 0) {
    struct stat status;
    assert(getpid() == 2 && getppid() == 1 && fstat(5, &status) == 0 && (S_ISFIFO(status.st_mode) || S_ISSOCK(status.st_mode)));
    assert(fcntl(6, F_GETFD) == -1 && errno == EBADF);
    char gate;
    assert(read(5, &gate, 1) == 1 && gate == 'G');
    close(5);
    assert(write(STDOUT_FILENO, "G", 1) == 1);
    for (;;) pause();
  }
  int identity[2], control[2], enabled = 1;
  assert(socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, identity) == 0);
  assert(setsockopt(identity[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof(enabled)) == 0);
  assert(pipe(control) == 0);
  pid_t child = fork();
  assert(child >= 0);
  if (child == 0) {
    close(identity[0]); close(control[1]);
    producer(identity[1], control[0], argv[1]);
  }
  close(identity[1]); close(control[0]);
  keiko_runtime_owner owner = {.supervisor = strcmp(argv[1], "credentials") == 0 ? getpid() : child,
    .root = -1, .control = -1, .response = -1, .identity = identity[0], .root_handle = -1};
  int before = descriptor_count();
  late_receive = strcmp(argv[1], "late") == 0;
  int accepted = keiko_owner_capture(&owner, keiko_tree_now_ms() + 5000u);
  assert(accepted == (strcmp(argv[1], "valid") == 0));
  assert(write(control[1], "X", 1) == 1);
  int status;
  assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
  if (accepted) {
    struct pollfd held = {owner.root_handle, POLLIN, 0};
    assert(poll(&held, 1, 0) == 1 && (held.revents & POLLIN) != 0);
  }
  keiko_owner_close(&owner.root_handle);
  assert(descriptor_count() == before);
  close(identity[0]); close(control[1]);
  return 0;
}
