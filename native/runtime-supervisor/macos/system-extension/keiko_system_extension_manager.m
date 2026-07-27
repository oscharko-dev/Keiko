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
#include <unistd.h>

static NSString *const KEIKO_EXTENSION_IDENTIFIER =
    @"com.oscharko.keiko.runtime-monitor.systemextension";

static int write_exact(int descriptor, const void *buffer, size_t length) {
  const unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = write(descriptor, bytes + offset, length - offset);
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

static int read_exact(int descriptor, void *buffer, size_t length) {
  unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t result = read(descriptor, bytes + offset, length - offset);
    if (result <= 0) return 0;
    offset += (size_t)result;
  }
  return 1;
}

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
    (void)waitpid(process, &status, 0);
  }
}

static int wait_for_active_monitor(void) {
  int settings_opened = 0;
  int unavailable_attempts = 0;
  for (;;) {
    uint16_t status = monitor_status();
    if (status == KEIKO_MONITOR_ACTIVE) return 1;
    if (status == KEIKO_MONITOR_FAILED) return 0;
    if (status == 0) {
      unavailable_attempts += 1;
      if (unavailable_attempts >= 240) return 0;
    } else {
      unavailable_attempts = 0;
    }
    if (status == KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS && !settings_opened) {
      open_full_disk_access_settings();
      settings_opened = 1;
    }
    usleep(250000);
  }
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
  (void)error;
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
  (void)dispatch_semaphore_wait(delegate.completion, DISPATCH_TIME_FOREVER);
  if (delegate.outcome != 0) return 1;
  if (!wait_for_active_monitor()) return 1;
  (void)puts("active");
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc != 2) return 1;
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
      return 1;
    }
    if (strcmp(argv[1], "--activate") == 0) return activate_extension();
    return 1;
  }
}
