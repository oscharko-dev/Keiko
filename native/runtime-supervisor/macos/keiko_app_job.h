#ifndef KEIKO_MACOS_APP_JOB_H
#define KEIKO_MACOS_APP_JOB_H

#include <mach-o/dyld.h>
#include <sys/stat.h>

/* launchd creates a distinct, kernel-inherited resource coalition for each temporary
 * application job. Only lifecycle descriptors cross this private, same-user socket;
 * application arguments and secrets continue through KRP/KAE, never launchctl argv. */
enum { KEIKO_JOB_DESCRIPTOR_COUNT = 9, KEIKO_JOB_CONTROL = 9 };

static int keiko_job_peer(int descriptor, pid_t *pid) {
  uid_t uid;
  gid_t gid;
  socklen_t size = sizeof(*pid);
  return getpeereid(descriptor, &uid, &gid) == 0 && uid == geteuid() &&
         getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, pid, &size) == 0 &&
         size == sizeof(*pid) && *pid > 1;
}

static int keiko_job_ready(int descriptor, short events, uint64_t deadline) {
  uint64_t now;
  for (;;) {
    if (!child_reap_time(&now) || now >= deadline) return 0;
    struct pollfd item = {descriptor, events, 0};
    int timeout = deadline - now > 100u ? 100 : (int)(deadline - now);
    int ready = poll(&item, 1, timeout);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0 || (item.revents & (POLLERR | POLLNVAL)) != 0) return 0;
    if (ready > 0) return (item.revents & (events | POLLHUP)) != 0;
  }
}

static int keiko_job_launchctl(char *const arguments[], uint64_t deadline) {
  posix_spawn_file_actions_t actions;
  posix_spawnattr_t attributes;
  pid_t child = -1;
  int initialized = 0, result = 0, status;
  char *const environment[] = {NULL};
  if (posix_spawn_file_actions_init(&actions) != 0) return 0;
  initialized = 1;
  if (posix_spawnattr_init(&attributes) != 0) goto cleanup;
  initialized = 2;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_CLOEXEC_DEFAULT) != 0) goto cleanup;
  for (int fd = 0; fd < 3; ++fd)
    if (posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", O_RDWR, 0) != 0) goto cleanup;
  if (posix_spawn(&child, "/bin/launchctl", &actions, &attributes, arguments, environment) != 0)
    goto cleanup;
  for (;;) {
    pid_t observed = waitpid(child, &status, WNOHANG);
    if (observed == child) { result = WIFEXITED(status) && WEXITSTATUS(status) == 0; child = -1; break; }
    if (observed < 0 && errno != EINTR) { child = -1; break; }
    uint64_t now;
    if (!child_reap_time(&now) || now >= deadline) break;
    if (poll(NULL, 0, 1) < 0 && errno != EINTR) break;
  }
cleanup:
  if (child > 0) { (void)kill(child, SIGKILL); while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} }
  if (initialized >= 2) posix_spawnattr_destroy(&attributes);
  posix_spawn_file_actions_destroy(&actions);
  return result;
}

static int keiko_app_probe(void) {
  uint64_t coalition = 0, now = 0;
  keiko_macos_process_identity identity;
  char domain[48];
  if (!keiko_macos_identity(getpid(), &identity) ||
      !keiko_macos_coalition(getpid(), &coalition) || access("/bin/launchctl", X_OK) != 0 ||
      !child_reap_time(&now) || now > UINT64_MAX - 1000u ||
      snprintf(domain, sizeof(domain), "gui/%lu", (unsigned long)geteuid()) <= 0)
    return ERROR_TREE_OBSERVE;
  char *const arguments[] = {"/bin/launchctl", "print", domain, NULL};
  return keiko_job_launchctl(arguments, now + 1000u) ? 0 : ERROR_TREE_OBSERVE;
}

static int keiko_job_send_descriptors(int channel, int owner_report,
                                      unsigned int inherited, uint64_t deadline) {
  union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int) * 9)]; } control;
  int descriptors[KEIKO_JOB_DESCRIPTOR_COUNT];
  unsigned char packet[3] = {(unsigned char)owner_report, 0, 0};
  struct iovec value = {packet, sizeof(packet)};
  struct msghdr message = {0};
  int result = 0;
  int fallback = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (fallback < 0) return 0;
  int moved = fcntl(fallback, F_DUPFD_CLOEXEC, 16);
  close(fallback);
  if (moved < 0) return 0;
  for (int fd = 0; fd < KEIKO_JOB_DESCRIPTOR_COUNT; ++fd) {
    descriptors[fd] = (inherited & (1u << fd)) != 0 ? fd : moved;
    if (descriptors[fd] == fd) packet[1 + fd / 8] |= (unsigned char)(1u << (fd % 8));
  }
  memset(&control, 0, sizeof(control));
  message.msg_iov = &value; message.msg_iovlen = 1;
  message.msg_control = control.bytes; message.msg_controllen = sizeof(control.bytes);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS;
  header->cmsg_len = CMSG_LEN(sizeof(descriptors));
  memcpy(CMSG_DATA(header), descriptors, sizeof(descriptors));
  if (keiko_job_ready(channel, POLLOUT, deadline)) {
    ssize_t count;
    do { count = sendmsg(channel, &message, 0); } while (count < 0 && errno == EINTR);
    result = count == (ssize_t)sizeof(packet);
  }
  close(moved);
  return result;
}

static int keiko_job_receive_descriptors(int channel, int *owner_report, uint64_t deadline) {
  union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(sizeof(int) * 9)]; } control;
  unsigned char packet[3] = {0};
  struct iovec value = {packet, sizeof(packet)};
  struct msghdr message = {0};
  int moved[KEIKO_JOB_DESCRIPTOR_COUNT];
  for (int i = 0; i < KEIKO_JOB_DESCRIPTOR_COUNT; ++i) moved[i] = -1;
  memset(&control, 0, sizeof(control));
  message.msg_iov = &value; message.msg_iovlen = 1;
  message.msg_control = control.bytes; message.msg_controllen = sizeof(control.bytes);
  if (!keiko_job_ready(channel, POLLIN, deadline)) return 0;
  ssize_t count;
  do { count = recvmsg(channel, &message, 0); } while (count < 0 && errno == EINTR);
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (count != (ssize_t)sizeof(packet) || packet[0] > 1 || packet[2] > 1 ||
      (message.msg_flags & (MSG_CTRUNC | MSG_TRUNC)) != 0 ||
      header == NULL || CMSG_NXTHDR(&message, header) != NULL ||
      header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS ||
      header->cmsg_len != CMSG_LEN(sizeof(int) * 9)) return 0;
  int descriptors[KEIKO_JOB_DESCRIPTOR_COUNT];
  memcpy(descriptors, CMSG_DATA(header), sizeof(descriptors));
  int result = 1;
  for (int i = 0; i < KEIKO_JOB_DESCRIPTOR_COUNT; ++i) {
    moved[i] = fcntl(descriptors[i], F_DUPFD_CLOEXEC, 16);
    close(descriptors[i]);
    if (moved[i] < 0) result = 0;
  }
  for (int i = 0; result && i < KEIKO_JOB_DESCRIPTOR_COUNT; ++i) {
    if ((packet[1 + i / 8] & (1u << (i % 8))) == 0) (void)close(i);
    else if (dup2(moved[i], i) < 0) result = 0;
  }
  for (int i = 0; i < KEIKO_JOB_DESCRIPTOR_COUNT; ++i) if (moved[i] >= 0) close(moved[i]);
  *owner_report = packet[0];
  return result;
}

static int keiko_job_self(char path[PATH_MAX]) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  return _NSGetExecutablePath(executable, &size) == 0 && realpath(executable, path) != NULL;
}

static int keiko_job_same_image(pid_t peer) {
  char self[PATH_MAX], other[PROC_PIDPATHINFO_MAXSIZE];
  struct stat own_file, peer_file;
  return keiko_job_self(self) && proc_pidpath(peer, other, sizeof(other)) > 0 &&
    strcmp(self, other) == 0 && lstat(self, &own_file) == 0 && lstat(other, &peer_file) == 0 &&
    S_ISREG(own_file.st_mode) && own_file.st_nlink == 1 &&
    own_file.st_dev == peer_file.st_dev && own_file.st_ino == peer_file.st_ino;
}

static int keiko_job_exited(pid_t peer, uint64_t unique_id, uint64_t deadline) {
  for (;;) {
    keiko_macos_process_identity observed;
    errno = 0;
    if (!keiko_macos_identity(peer, &observed)) return errno == ESRCH;
    if (observed.unique_id != unique_id) return 1;
    uint64_t now;
    if (!child_reap_time(&now) || now >= deadline) return 0;
    if (poll(NULL, 0, 1) < 0 && errno != EINTR) return 0;
  }
}

static int keiko_job_xml_string(int descriptor, const char *value) {
  if (!write_exact(descriptor, "<string>", 8)) return 0;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor != 0; ++cursor) {
    const char *escaped = *cursor == '&' ? "&amp;" : *cursor == '<' ? "&lt;" :
      *cursor == '>' ? "&gt;" : *cursor == '"' ? "&quot;" : *cursor == '\'' ? "&apos;" : NULL;
    if (*cursor < 0x20 || (escaped == NULL ? !write_exact(descriptor, cursor, 1)
                                       : !write_exact(descriptor, escaped, strlen(escaped)))) return 0;
  }
  return write_exact(descriptor, "</string>", 9);
}

static int keiko_job_plist(const char *path, const char *label,
                             const char *executable, const char *socket_path) {
  const char prefix[] = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
    "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">"
    "<plist version=\"1.0\"><dict><key>Label</key>";
  const char arguments[] = "<key>ProgramArguments</key><array>";
  const char suffix[] = "</array><key>RunAtLoad</key><true/>"
    "<key>KeepAlive</key><false/><key>ProcessType</key><string>Interactive</string>"
    "<key>ExitTimeOut</key><integer>5</integer></dict></plist>";
  int descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (descriptor < 0) return 0;
  int result = write_exact(descriptor, prefix, sizeof(prefix) - 1u) &&
    keiko_job_xml_string(descriptor, label) &&
    write_exact(descriptor, arguments, sizeof(arguments) - 1u) &&
    keiko_job_xml_string(descriptor, "/usr/bin/env") && keiko_job_xml_string(descriptor, "-i") &&
    keiko_job_xml_string(descriptor, executable) && keiko_job_xml_string(descriptor, "--app-job") &&
    keiko_job_xml_string(descriptor, socket_path) &&
    write_exact(descriptor, suffix, sizeof(suffix) - 1u);
  if (close(descriptor) != 0) result = 0;
  return result;
}

static int keiko_job_bridge(int owner_report) {
  char directory[] = "/tmp/keiko-app-XXXXXX", path[PATH_MAX] = {0}, label[80], self[PATH_MAX];
  char plist[PATH_MAX] = {0}, domain[48], service[128];
  int listener = -1, channel = -1, result = 1, submitted = 0, handed_off = 0;
  uint64_t deadline;
  unsigned int inherited = 0;
  keiko_macos_process_identity identity = {0};
  pid_t peer = -1;
  for (int fd = 0; fd < KEIKO_JOB_DESCRIPTOR_COUNT; ++fd)
    if (fcntl(fd, F_GETFD) >= 0) inherited |= 1u << fd;
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR || !child_reap_time(&deadline) ||
      deadline > UINT64_MAX - 5000u) {
    (void)send_error(ERROR_TREE_OBSERVE);
    return 1;
  }
  deadline += 5000u;
  if (mkdtemp(directory) == NULL) {
    (void)send_error(ERROR_TREE_OBSERVE);
    return 1;
  }
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  if (snprintf(path, sizeof(path), "%s/control", directory) <= 0 ||
      strlen(path) >= sizeof(address.sun_path) ||
      snprintf(label, sizeof(label), "dev.keiko.app.%s", strrchr(directory, '/') + 1) <= 0 ||
      snprintf(plist, sizeof(plist), "%s/job.plist", directory) <= 0 ||
      snprintf(domain, sizeof(domain), "gui/%lu", (unsigned long)geteuid()) <= 0 ||
      snprintf(service, sizeof(service), "%s/%s", domain, label) <= 0 ||
      !keiko_job_self(self) || (listener = socket(AF_UNIX, SOCK_STREAM, 0)) < 0) goto cleanup;
  memcpy(address.sun_path, path, strlen(path) + 1u);
  if (fcntl(listener, F_SETFD, FD_CLOEXEC) != 0 ||
      bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(listener, 1) != 0 || !keiko_job_plist(plist, label, self, path)) goto cleanup;
  /* An ephemeral login-session job, never an installed LaunchAgent or a keepalive service. */
  char *const arguments[] = {"/bin/launchctl", "bootstrap", domain, plist, NULL};
  submitted = 1;
  if (!keiko_job_launchctl(arguments, deadline)) goto cleanup;
  if (!keiko_job_ready(listener, POLLIN, deadline) || (channel = accept(listener, NULL, NULL)) < 0)
    goto cleanup;
  struct proc_bsdinfo info;
  if (fcntl(channel, F_SETFD, FD_CLOEXEC) != 0 || !keiko_job_peer(channel, &peer) ||
      !keiko_job_same_image(peer) ||
      proc_pidinfo(peer, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_ppid != 1 || !keiko_macos_identity(peer, &identity) ||
      !keiko_job_send_descriptors(channel, owner_report, inherited, deadline)) goto cleanup;
  /* The job may now write KRS1. Never introduce a second response writer, even
   * when its installation acknowledgement cannot be observed. */
  handed_off = 1;
  unsigned char installed = 0;
  if (!keiko_job_ready(channel, POLLIN, deadline) || read(channel, &installed, 1) != 1 ||
      installed != 0xa5) goto cleanup;
  close(listener); listener = -1;
  for (int fd = 3; fd < KEIKO_JOB_DESCRIPTOR_COUNT; ++fd)
    if ((inherited & (1u << fd)) != 0) close(fd);
  unsigned char outcome = 1;
  for (;;) {
    struct pollfd item = {channel, POLLIN | POLLHUP, 0};
    int ready = poll(&item, 1, -1);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (item.revents & (POLLERR | POLLNVAL)) != 0) break;
    if (read(channel, &outcome, 1) == 1 && outcome == 0) result = 0;
    break;
  }
  if (!child_reap_time(&deadline)) { result = 1; goto cleanup; }
  deadline += 5000u;
  if (!keiko_job_exited(peer, identity.unique_id, deadline)) result = 1;
cleanup:
  if (channel >= 0) close(channel);
  if (listener >= 0) close(listener);
  if (submitted) {
    char *const remove[] = {"/bin/launchctl", "bootout", service, NULL};
    uint64_t now;
    if (!child_reap_time(&now) ||
        (identity.unique_id != 0 && !keiko_job_exited(peer, identity.unique_id, now + 5000u)) ||
        !keiko_job_launchctl(remove, now + 6000u)) result = 1;
  }
  (void)unlink(plist); (void)unlink(path); (void)rmdir(directory);
  if (result != 0 && !handed_off) (void)send_error(ERROR_TREE_OBSERVE);
  return result;
}

static int keiko_job_run(const char *path) {
  extern char **environ;
  struct sockaddr_un address = {0};
  uint64_t deadline;
  int channel = -1, owner_report = 0, result = 1;
  pid_t peer;
  address.sun_family = AF_UNIX;
  /* The platform-owned env executable clears launchd's loader environment before
   * this exact helper image starts, preserving the original native clean-env boundary. */
  if ((environ != NULL && environ[0] != NULL) || getppid() != 1 ||
      strlen(path) >= sizeof(address.sun_path) ||
      !child_reap_time(&deadline)) return 1;
  deadline += 5000u;
  memcpy(address.sun_path, path, strlen(path) + 1u);
  channel = socket(AF_UNIX, SOCK_STREAM, 0);
  if (channel < 0 || connect(channel, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      !keiko_job_peer(channel, &peer) || !keiko_job_same_image(peer)) goto cleanup;
  int moved = fcntl(channel, F_DUPFD_CLOEXEC, 16);
  close(channel); channel = moved;
  if (channel < 0 || !keiko_job_receive_descriptors(channel, &owner_report, deadline) ||
      dup2(channel, KEIKO_JOB_CONTROL) < 0 ||
      fcntl(KEIKO_JOB_CONTROL, F_SETFD, FD_CLOEXEC) != 0) goto cleanup;
  unsigned char installed = 0xa5;
  if (write(channel, &installed, 1) != 1) goto cleanup;
  result = keiko_app_runtime(owner_report);
  unsigned char outcome = (unsigned char)result;
  (void)write(channel, &outcome, 1);
cleanup:
  if (channel >= 0) close(channel);
  return result;
}

#endif
