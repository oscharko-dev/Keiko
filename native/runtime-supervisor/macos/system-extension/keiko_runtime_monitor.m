#import <EndpointSecurity/EndpointSecurity.h>
#import <Security/Security.h>

#include "../keiko_runtime_monitor_protocol.h"

#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#define KEIKO_MAX_SESSIONS 16u
#define KEIKO_MAX_PROCESSES 4096u

struct monitor_session {
  int active;
  int descriptor;
  uid_t uid;
  pid_t supervisor_pid;
  char recovery_handle[KEIKO_RECOVERY_HANDLE_BYTES];
  pid_t processes[KEIKO_MAX_PROCESSES];
  size_t process_count;
  int stopping;
  int root_observed;
};

static struct monitor_session sessions[KEIKO_MAX_SESSIONS];
static pthread_mutex_t sessions_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_mutex_t endpoint_state_lock = PTHREAD_MUTEX_INITIALIZER;
static es_client_t *endpoint_client;

enum endpoint_state {
  ENDPOINT_STATE_STARTING = 1,
  ENDPOINT_STATE_NEEDS_FULL_DISK_ACCESS = 2,
  ENDPOINT_STATE_ACTIVE = 3,
  ENDPOINT_STATE_FAILED = 4
};

static enum endpoint_state endpoint_state = ENDPOINT_STATE_STARTING;

_Static_assert(sizeof(struct keiko_monitor_request) == 44, "monitor request layout");
_Static_assert(sizeof(struct keiko_monitor_reply) == 12, "monitor reply layout");

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

static void reply_to(struct monitor_session *session, uint16_t kind) {
  struct keiko_monitor_reply reply;
  if (session->descriptor < 0) return;
  memset(&reply, 0, sizeof(reply));
  memcpy(reply.magic, "KES1", 4);
  reply.version = KEIKO_MONITOR_VERSION;
  reply.kind = kind;
  reply.live_processes = (uint32_t)session->process_count;
  (void)send(session->descriptor, &reply, sizeof(reply), MSG_DONTWAIT);
}

static void set_endpoint_state(enum endpoint_state state) {
  pthread_mutex_lock(&endpoint_state_lock);
  endpoint_state = state;
  pthread_mutex_unlock(&endpoint_state_lock);
}

static enum endpoint_state current_endpoint_state(void) {
  enum endpoint_state state;
  pthread_mutex_lock(&endpoint_state_lock);
  state = endpoint_state;
  pthread_mutex_unlock(&endpoint_state_lock);
  return state;
}

static uint16_t endpoint_status_reply(void) {
  switch (current_endpoint_state()) {
    case ENDPOINT_STATE_ACTIVE:
      return KEIKO_MONITOR_ACTIVE;
    case ENDPOINT_STATE_NEEDS_FULL_DISK_ACCESS:
      return KEIKO_MONITOR_NEEDS_FULL_DISK_ACCESS;
    case ENDPOINT_STATE_STARTING:
      return KEIKO_MONITOR_STARTING;
    case ENDPOINT_STATE_FAILED:
      return KEIKO_MONITOR_FAILED;
  }
  return KEIKO_MONITOR_FAILED;
}

static int handle_valid(const char handle[KEIKO_RECOVERY_HANDLE_BYTES]) {
  size_t index;
  for (index = 0; index < KEIKO_RECOVERY_HANDLE_BYTES; ++index) {
    char value = handle[index];
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return 0;
  }
  return 1;
}

static int session_contains(const struct monitor_session *session, pid_t pid) {
  size_t index;
  for (index = 0; index < session->process_count; ++index)
    if (session->processes[index] == pid) return 1;
  return 0;
}

static void kill_session_processes(const struct monitor_session *session) {
  size_t index;
  for (index = 0; index < session->process_count; ++index)
    (void)kill(session->processes[index], SIGKILL);
}

static void session_add(struct monitor_session *session, pid_t pid) {
  if (session_contains(session, pid)) return;
  if (session->process_count >= KEIKO_MAX_PROCESSES) {
    session->stopping = 1;
    (void)kill(pid, SIGKILL);
    kill_session_processes(session);
    reply_to(session, KEIKO_MONITOR_ERROR);
    return;
  }
  session->processes[session->process_count++] = pid;
  if (session->stopping) (void)kill(pid, SIGKILL);
}

static void session_remove(struct monitor_session *session, pid_t pid) {
  size_t index;
  for (index = 0; index < session->process_count; ++index) {
    if (session->processes[index] != pid) continue;
    session->processes[index] = session->processes[session->process_count - 1];
    session->process_count -= 1;
    if (session->process_count == 0) {
      if (session->descriptor >= 0) {
        reply_to(session, KEIKO_MONITOR_ZERO_LIVE);
      } else {
        memset(session, 0, sizeof(*session));
      }
    }
    return;
  }
}

static struct monitor_session *session_for_pid(pid_t pid) {
  size_t index;
  for (index = 0; index < KEIKO_MAX_SESSIONS; ++index) {
    struct monitor_session *session = &sessions[index];
    if (session->active &&
        (session->supervisor_pid == pid || session_contains(session, pid)))
      return session;
  }
  return NULL;
}

static struct monitor_session *session_for_handle(
    const char handle[KEIKO_RECOVERY_HANDLE_BYTES]) {
  size_t index;
  for (index = 0; index < KEIKO_MAX_SESSIONS; ++index) {
    struct monitor_session *session = &sessions[index];
    if (session->active &&
        memcmp(session->recovery_handle, handle, KEIKO_RECOVERY_HANDLE_BYTES) == 0)
      return session;
  }
  return NULL;
}

static void stop_session(struct monitor_session *session) {
  pid_t processes[KEIKO_MAX_PROCESSES];
  size_t count, index;
  pthread_mutex_lock(&sessions_lock);
  session->stopping = 1;
  count = session->process_count;
  memcpy(processes, session->processes, count * sizeof(pid_t));
  if (count == 0 && session->descriptor >= 0)
    reply_to(session, KEIKO_MONITOR_ZERO_LIVE);
  pthread_mutex_unlock(&sessions_lock);
  for (index = 0; index < count; ++index) (void)kill(processes[index], SIGKILL);
}

static void endpoint_event(es_client_t *client, const es_message_t *message) {
  pid_t process_pid = audit_token_to_pid(message->process->audit_token);
  pthread_mutex_lock(&sessions_lock);
  if (message->event_type == ES_EVENT_TYPE_NOTIFY_FORK) {
    pid_t child_pid = audit_token_to_pid(message->event.fork.child->audit_token);
    struct monitor_session *session = session_for_pid(process_pid);
    if (session != NULL) {
      session_add(session, child_pid);
      if (process_pid == session->supervisor_pid && !session->root_observed) {
        session->root_observed = 1;
        reply_to(session, KEIKO_MONITOR_ROOT_OBSERVED);
      }
    }
  } else if (message->event_type == ES_EVENT_TYPE_NOTIFY_EXIT) {
    struct monitor_session *session = session_for_pid(process_pid);
    if (session != NULL) session_remove(session, process_pid);
  } else if (message->event_type == ES_EVENT_TYPE_AUTH_EXEC) {
    struct monitor_session *session = session_for_pid(process_pid);
    es_auth_result_t result =
        session != NULL && session->stopping ? ES_AUTH_RESULT_DENY : ES_AUTH_RESULT_ALLOW;
    (void)es_respond_auth_result(client, message, result, false);
  }
  pthread_mutex_unlock(&sessions_lock);
}

static CFStringRef team_identifier_for_code(SecCodeRef code) {
  CFDictionaryRef information = NULL;
  CFStringRef team = NULL;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation, &information) == errSecSuccess) {
    CFTypeRef value = CFDictionaryGetValue(information, kSecCodeInfoTeamIdentifier);
    if (value != NULL && CFGetTypeID(value) == CFStringGetTypeID()) {
      team = (CFStringRef)CFRetain(value);
    }
    CFRelease(information);
  }
  return team;
}

static int same_team_process(pid_t pid) {
  SecCodeRef self = NULL, guest = NULL;
  CFStringRef self_team = NULL, guest_team = NULL;
  CFNumberRef process = CFNumberCreate(NULL, kCFNumberIntType, &pid);
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {process};
  CFDictionaryRef attributes =
      CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  int matches = 0;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &self) == errSecSuccess &&
      SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &guest) ==
          errSecSuccess &&
      SecCodeCheckValidity(guest, kSecCSStrictValidate, NULL) == errSecSuccess) {
    self_team = team_identifier_for_code(self);
    guest_team = team_identifier_for_code(guest);
    matches = self_team != NULL && guest_team != NULL &&
              CFEqual(self_team, guest_team);
  }
  if (guest_team != NULL) CFRelease(guest_team);
  if (self_team != NULL) CFRelease(self_team);
  if (guest != NULL) CFRelease(guest);
  if (self != NULL) CFRelease(self);
  CFRelease(attributes);
  CFRelease(process);
  return matches;
}

static pid_t peer_pid(int descriptor) {
  pid_t pid = 0;
  socklen_t length = sizeof(pid);
  return getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0 ? pid : 0;
}

static struct monitor_session *allocate_session(int descriptor, uid_t uid,
                                                const struct keiko_monitor_request *request) {
  size_t index;
  if (session_for_handle(request->recovery_handle) != NULL) return NULL;
  for (index = 0; index < KEIKO_MAX_SESSIONS; ++index) {
    struct monitor_session *session = &sessions[index];
    if (session->active) continue;
    memset(session, 0, sizeof(*session));
    session->active = 1;
    session->descriptor = descriptor;
    session->uid = uid;
    session->supervisor_pid = (pid_t)request->supervisor_pid;
    memcpy(session->recovery_handle, request->recovery_handle, KEIKO_RECOVERY_HANDLE_BYTES);
    return session;
  }
  return NULL;
}

static void close_session(struct monitor_session *session) {
  stop_session(session);
  pthread_mutex_lock(&sessions_lock);
  session->descriptor = -1;
  if (session->process_count == 0) memset(session, 0, sizeof(*session));
  pthread_mutex_unlock(&sessions_lock);
}

static int request_valid(const struct keiko_monitor_request *request, pid_t peer) {
  return memcmp(request->magic, "KEM1", 4) == 0 &&
         request->version == KEIKO_MONITOR_VERSION &&
         request->supervisor_pid == (uint32_t)peer;
}

static void *serve_client(void *opaque) {
  int descriptor = *(int *)opaque;
  struct keiko_monitor_request request;
  struct monitor_session transient;
  struct monitor_session *session = NULL;
  uid_t uid;
  gid_t gid;
  pid_t peer = peer_pid(descriptor);
  free(opaque);
  memset(&transient, 0, sizeof(transient));
  transient.descriptor = descriptor;
  if (peer <= 0 || getpeereid(descriptor, &uid, &gid) != 0 || !same_team_process(peer) ||
      !read_exact(descriptor, &request, sizeof(request)) || !request_valid(&request, peer)) {
    close(descriptor);
    return NULL;
  }
  if (request.command == KEIKO_MONITOR_PING) {
    reply_to(&transient, endpoint_status_reply());
    close(descriptor);
    return NULL;
  }
  if (current_endpoint_state() != ENDPOINT_STATE_ACTIVE) {
    reply_to(&transient, KEIKO_MONITOR_ERROR);
    close(descriptor);
    return NULL;
  }
  if (!handle_valid(request.recovery_handle)) {
    reply_to(&transient, KEIKO_MONITOR_ERROR);
    close(descriptor);
    return NULL;
  }
  pthread_mutex_lock(&sessions_lock);
  if (request.command == KEIKO_MONITOR_ARM) {
    session = allocate_session(descriptor, uid, &request);
  } else if (request.command == KEIKO_MONITOR_RECONCILE) {
    session = session_for_handle(request.recovery_handle);
    if (session != NULL && session->descriptor < 0) {
      session->descriptor = descriptor;
    } else {
      session = NULL;
    }
  }
  pthread_mutex_unlock(&sessions_lock);
  if (session == NULL) {
    if (request.command == KEIKO_MONITOR_RECONCILE) {
      reply_to(&transient, KEIKO_MONITOR_ZERO_LIVE);
    } else {
      reply_to(&transient, KEIKO_MONITOR_ERROR);
    }
    close(descriptor);
    return NULL;
  }
  if (request.command == KEIKO_MONITOR_RECONCILE) {
    stop_session(session);
  } else {
    reply_to(session, KEIKO_MONITOR_ARMED);
  }
  while (read_exact(descriptor, &request, sizeof(request)) &&
         request_valid(&request, peer)) {
    if (request.command != KEIKO_MONITOR_STOP ||
        memcmp(request.recovery_handle, session->recovery_handle,
               KEIKO_RECOVERY_HANDLE_BYTES) != 0)
      break;
    stop_session(session);
  }
  close_session(session);
  close(descriptor);
  return NULL;
}

static int listening_socket(void) {
  struct sockaddr_un address;
  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor == -1) return -1;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  (void)snprintf(address.sun_path, sizeof(address.sun_path), "%s", KEIKO_MONITOR_SOCKET);
  (void)unlink(KEIKO_MONITOR_SOCKET);
  if (bind(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(KEIKO_MONITOR_SOCKET, 0666) != 0 || listen(descriptor, 16) != 0) {
    close(descriptor);
    return -1;
  }
  return descriptor;
}

static void *start_endpoint_security(void *opaque) {
  es_event_type_t events[] = {ES_EVENT_TYPE_NOTIFY_FORK, ES_EVENT_TYPE_AUTH_EXEC,
                              ES_EVENT_TYPE_NOTIFY_EXIT};
  (void)opaque;
  for (;;) {
    es_client_t *candidate = NULL;
    es_new_client_result_t result =
        es_new_client(&candidate, ^(es_client_t *client, const es_message_t *message) {
          endpoint_event(client, message);
        });
    if (result == ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED) {
      set_endpoint_state(ENDPOINT_STATE_NEEDS_FULL_DISK_ACCESS);
      sleep(1);
      continue;
    }
    if (result != ES_NEW_CLIENT_RESULT_SUCCESS || candidate == NULL) {
      set_endpoint_state(ENDPOINT_STATE_FAILED);
      return NULL;
    }
    if (es_subscribe(candidate, events, sizeof(events) / sizeof(events[0])) !=
        ES_RETURN_SUCCESS) {
      es_delete_client(candidate);
      set_endpoint_state(ENDPOINT_STATE_FAILED);
      return NULL;
    }
    pthread_mutex_lock(&endpoint_state_lock);
    endpoint_client = candidate;
    endpoint_state = ENDPOINT_STATE_ACTIVE;
    pthread_mutex_unlock(&endpoint_state_lock);
    return NULL;
  }
}

int main(void) {
  int listener = listening_socket();
  pthread_t endpoint_thread;
  if (listener == -1 ||
      pthread_create(&endpoint_thread, NULL, start_endpoint_security, NULL) != 0) {
    return 1;
  }
  (void)pthread_detach(endpoint_thread);
  for (;;) {
    int descriptor = accept(listener, NULL, NULL);
    pthread_t thread;
    int *owned;
    if (descriptor == -1) continue;
    (void)setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &(int){1}, sizeof(int));
    owned = malloc(sizeof(int));
    if (owned == NULL) {
      close(descriptor);
      continue;
    }
    *owned = descriptor;
    if (pthread_create(&thread, NULL, serve_client, owned) != 0) {
      free(owned);
      close(descriptor);
      continue;
    }
    (void)pthread_detach(thread);
  }
}
