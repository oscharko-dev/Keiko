#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>

#include "../keiko_runtime_monitor_protocol.h"

#include <fcntl.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <os/log.h>
#include <errno.h>
#include <unistd.h>

static NSString *const KEIKO_EXTENSION_IDENTIFIER =
    @"com.oscharko.keiko.runtime-monitor.systemextension";

#define KEIKO_ACTIVATION_TIMEOUT_SECONDS 600u
#define KEIKO_MONITOR_ATTEMPTS 2400u

static uint16_t monitor_status(void) {
  struct sockaddr_un address;
  struct keiko_monitor_request request;
  struct keiko_monitor_reply reply;
  struct timeval timeout = {.tv_sec = 1, .tv_usec = 0};
  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor == -1) return 0;
  (void)setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  (void)setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(address.sun_path, sizeof(address.sun_path), "%s", KEIKO_MONITOR_SOCKET);
  if (connect(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(descriptor);
    return 0;
  }
  memset(&request, 0, sizeof(request));
  memcpy(request.magic, "KEM1", 4);
  request.version = KEIKO_MONITOR_VERSION;
  request.command = KEIKO_MONITOR_PING;
  request.supervisor_pid = (uint32_t)getpid();
  if (!write_exact(descriptor, &request, sizeof(request)) ||
      !read_exact(descriptor, &reply, sizeof(reply))) {
    close(descriptor);
    return 0;
  }
  close(descriptor);
  if (memcmp(reply.magic, "KES1", 4) != 0 || reply.version != KEIKO_MONITOR_VERSION)
    return 0;
  return reply.kind;
}

static int monitor_active(void) {
  return monitor_status() == KEIKO_MONITOR_ACTIVE;
}

static void open_full_disk_access_settings(void) {
  NSOperatingSystemVersion version =
      [[NSProcessInfo processInfo] operatingSystemVersion];
  const char *settings =
      version.majorVersion >= 13
          ? "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles"
          : "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
  char *arguments[] = {"/usr/bin/open", (char *)settings, NULL};
  char *environment[] = {"PATH=/usr/bin", NULL};
  pid_t process = 0;
  if (posix_spawn(&process, "/usr/bin/open", NULL, NULL, arguments, environment) == 0) {
    int status = 0;
    // KEIKO-0968: the (void)waitpid(...) return-cast used to silently discard both waitpid()
    // failures AND non-zero exits of `/usr/bin/open`, so a broken settings-launch was invisible
    // to any diagnostic — the user's "System Settings does not open" turned into "the extension
    // will never activate" with no trace. Route both signals to the shared os_log line the rest
    // of the manager uses.
    pid_t waited = waitpid(process, &status, 0);
    if (waited == -1) {
      os_log_error(OS_LOG_DEFAULT,
                   "keiko system-extension manager: waitpid(/usr/bin/open) failed: errno=%d",
                   errno);
    } else if (WIFEXITED(status) && WEXITSTATUS(status) != 0) {
      os_log_error(OS_LOG_DEFAULT,
                   "keiko system-extension manager: /usr/bin/open exited with %d",
                   WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
      os_log_error(OS_LOG_DEFAULT,
                   "keiko system-extension manager: /usr/bin/open terminated by signal %d",
                   WTERMSIG(status));
    }
  }
}

static int wait_for_active_monitor(void) {
  int settings_opened = 0;
  unsigned int attempt;
  for (attempt = 0; attempt < KEIKO_MONITOR_ATTEMPTS; ++attempt) {
    uint16_t status = monitor_status();
    if (status == KEIKO_MONITOR_ACTIVE) return 1;
    if (status == KEIKO_MONITOR_FAILED) return 0;
    if (status == KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS && !settings_opened) {
      open_full_disk_access_settings();
      settings_opened = 1;
    }
    usleep(250000);
  }
  return 0;
}

@interface KeikoActivationDelegate : NSObject <OSSystemExtensionRequestDelegate>
@property(nonatomic) dispatch_semaphore_t completion;
@property(nonatomic) int outcome;
@end

@implementation KeikoActivationDelegate

- (void)request:(OSSystemExtensionRequest *)request
    didFinishWithResult:(OSSystemExtensionRequestResult)result {
  (void)request;
  self.outcome = result == OSSystemExtensionRequestCompleted ? 0 : 1;
  dispatch_semaphore_signal(self.completion);
}

- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error {
  (void)request;
  // KEIKO-0450: the OS-supplied reason was discarded here, so every activation failure reached the
  // operator as the same generic message and the one party who knew WHY (the OS) was never heard.
  // localizedDescription only — dumping the whole NSError would carry more detail than a CLI
  // diagnostic should. Failure paths only: portable-macos-activation.ts requires stderr to be
  // empty on success, so nothing may be written on the success paths below.
  fprintf(stderr, "keiko-system-extension-manager: activation request failed: %s\n",
          error.localizedDescription.UTF8String);
  self.outcome = 1;
  dispatch_semaphore_signal(self.completion);
}

- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request {
  (void)request;
}

- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request
    actionForReplacingExtension:(OSSystemExtensionProperties *)existing
                   withExtension:(OSSystemExtensionProperties *)replacement {
  (void)request;
  (void)existing;
  (void)replacement;
  return OSSystemExtensionReplacementActionReplace;
}

@end

static int activate_extension(void) {
  if (monitor_active()) {
    (void)puts("active");
    return 0;
  }
  dispatch_queue_t queue =
      dispatch_queue_create("com.oscharko.keiko.runtime-monitor.activation", DISPATCH_QUEUE_SERIAL);
  KeikoActivationDelegate *delegate = [[KeikoActivationDelegate alloc] init];
  delegate.completion = dispatch_semaphore_create(0);
  delegate.outcome = 1;
  OSSystemExtensionRequest *request =
      [OSSystemExtensionRequest activationRequestForExtension:KEIKO_EXTENSION_IDENTIFIER
                                                        queue:queue];
  request.delegate = delegate;
  [[OSSystemExtensionManager sharedManager] submitRequest:request];
  dispatch_time_t deadline = dispatch_time(
      DISPATCH_TIME_NOW, (int64_t)KEIKO_ACTIVATION_TIMEOUT_SECONDS * NSEC_PER_SEC);
  // KEIKO-0450: three distinct causes used to share one silent `return 1`, so an operator could not
  // tell "the user never answered the approval prompt" from "the OS refused" from "approval
  // succeeded but the daemon never came up" — three different next actions.
  if (dispatch_semaphore_wait(delegate.completion, deadline) != 0) {
    fprintf(stderr,
            "keiko-system-extension-manager: the system extension approval did not complete "
            "within %d seconds. Approve Keiko in System Settings > General > Login Items & "
            "Extensions, then run --activate again.\n",
            (int)KEIKO_ACTIVATION_TIMEOUT_SECONDS);
    return 1;
  }
  if (delegate.outcome != 0) {
    fprintf(stderr,
            "keiko-system-extension-manager: macOS reported the activation request as failed (see "
            "the activation-request diagnostic above for the OS-supplied reason).\n");
    return 1;
  }
  if (!wait_for_active_monitor()) {
    fprintf(stderr,
            "keiko-system-extension-manager: the extension was approved but the runtime monitor "
            "never reached the active state. Check `log show --predicate 'subsystem == "
            "\"com.oscharko.keiko.runtime-monitor\"'` for the daemon's own diagnostics.\n");
    return 1;
  }
  (void)puts("active");
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) {
      fprintf(stderr, "keiko-system-extension-manager: usage: %s --status|--activate\n",
              argc > 0 ? argv[0] : "keiko_system_extension_manager");
      return 1;
    }
    if (strcmp(argv[1], "--status") == 0) {
      uint16_t status = monitor_status();
      if (status == KEIKO_MONITOR_ACTIVE) {
        (void)puts("active");
        return 0;
      }
      if (status == KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS) {
        (void)puts("needs-full-disk-access");
        return 2;
      }
      // KEIKO-0450: STARTING, FAILED and "could not reach the daemon at all" collapsed into one
      // bare `return 1`. Report the raw status so the caller can distinguish "wait and retry" from
      // "activation is broken".
      fprintf(stderr, "keiko-system-extension-manager: runtime monitor is not active (status=%u)\n",
              (unsigned)status);
      return 1;
    }
    if (strcmp(argv[1], "--activate") == 0) return activate_extension();
    /* The argument is not echoed: a wrapper can pass a path or token by mistake, and this stderr
     * is captured into activation logs. The usage line is the whole actionable content. */
    fprintf(stderr,
            "keiko-system-extension-manager: unknown option; expected --status or --activate\n");
    return 1;
  }
}
