#ifndef KEIKO_PORTABLE_UPDATE_ENGINE_H
#define KEIKO_PORTABLE_UPDATE_ENGINE_H

#include <stdint.h>

/*
 * Platform-neutral lifecycle policy. Compile-selected adapters own filesystem,
 * process, port, supervisor-transport, and clock mechanics; this engine alone
 * owns forward/restore ordering and the semantic acknowledgement boundary.
 */
typedef struct {
  void *context;
  int (*deadline)(void *context, int field, uint64_t *deadline_ms);
  int (*emit_acceptance)(void *context);
  int (*wait_old_exit)(void *context);
  int (*promote)(void *context, uint64_t deadline_ms);
  int (*publish_registration)(void *context, uint64_t deadline_ms);
  int (*start_runtime)(void *context, uint64_t deadline_ms, int restoring);
  int (*wait_receipt)(void *context, const char *kind, const char *outcome,
                      uint64_t deadline_ms);
  int (*next_receipt_exists)(void *context);
  int (*stop_runtime)(void *context, uint64_t deadline_ms);
  int (*reconcile_stopped_runtime)(void *context, uint64_t deadline_ms);
  int (*stop_failed_start)(void *context, uint64_t deadline_ms);
  int (*wait_verified_ack)(void *context, uint64_t deadline_ms);
  int (*cleanup_verified)(void *context, uint64_t deadline_ms);
  int (*restore_previous)(void *context, uint64_t deadline_ms);
  void (*hold_runtime)(void *context);
} keiko_coordinator_engine;

static inline int keiko_coordinator_execute_engine(
    const keiko_coordinator_engine *engine,
    int start_at_field,
    int verify_at_field,
    int cleanup_at_field
) {
  uint64_t start_deadline;
  uint64_t verify_deadline;
  uint64_t cleanup_deadline;
  void *context;
  if (engine == NULL || engine->context == NULL || engine->deadline == NULL ||
      engine->emit_acceptance == NULL || engine->wait_old_exit == NULL ||
      engine->promote == NULL || engine->publish_registration == NULL ||
      engine->start_runtime == NULL || engine->wait_receipt == NULL ||
      engine->next_receipt_exists == NULL || engine->stop_runtime == NULL ||
      engine->reconcile_stopped_runtime == NULL || engine->stop_failed_start == NULL ||
      engine->wait_verified_ack == NULL || engine->cleanup_verified == NULL ||
      engine->restore_previous == NULL || engine->hold_runtime == NULL) {
    return 0;
  }
  context = engine->context;
  if (!engine->deadline(context, start_at_field, &start_deadline) ||
      !engine->deadline(context, verify_at_field, &verify_deadline) ||
      !engine->deadline(context, cleanup_at_field, &cleanup_deadline) ||
      !engine->emit_acceptance(context) || !engine->wait_old_exit(context)) {
    return 0;
  }
  if (!engine->promote(context, start_deadline) ||
      !engine->publish_registration(context, start_deadline)) {
    goto restore_without_runtime;
  }
  if (!engine->start_runtime(context, start_deadline, 0)) {
    if (!engine->stop_failed_start(context, cleanup_deadline)) return 0;
    goto restore_without_runtime;
  }
  if (!engine->wait_receipt(context, "verify", "intent", verify_deadline)) {
    if (engine->next_receipt_exists(context) ||
        !engine->stop_runtime(context, cleanup_deadline)) {
      engine->hold_runtime(context);
      return 0;
    }
    if (!engine->reconcile_stopped_runtime(context, cleanup_deadline)) return 0;
    goto restore_without_runtime;
  }
  if (!engine->wait_receipt(context, "verify", "completed", verify_deadline) ||
      !engine->wait_verified_ack(context, verify_deadline)) {
    engine->hold_runtime(context);
    return 0;
  }
  if (!engine->cleanup_verified(context, cleanup_deadline)) {
    engine->hold_runtime(context);
    return 0;
  }
  engine->hold_runtime(context);
  return 1;

restore_without_runtime:
  if (!engine->restore_previous(context, cleanup_deadline) ||
      !engine->start_runtime(context, cleanup_deadline, 1) ||
      !engine->wait_receipt(
          context,
          "restored-verify",
          "intent",
          cleanup_deadline
      ) ||
      !engine->wait_receipt(
          context,
          "restored-verify",
          "completed",
          cleanup_deadline
      )) {
    engine->hold_runtime(context);
    return 0;
  }
  engine->hold_runtime(context);
  return 1;
}

static inline int keiko_recovery_forward_expected(
    unsigned int forward_count,
    const char **kind,
    const char **outcome
) {
  static const char *const forward_kind[] = {
      "prepared", "old-exit", "old-exit", "promote", "promote", "register", "register",
      "start", "start", "verify", "verify", "cleanup", "cleanup", "complete"};
  static const char *const forward_outcome[] = {
      "completed", "intent", "completed", "intent", "completed", "intent", "completed",
      "intent", "completed", "intent", "completed", "intent", "completed", "completed"};
  if (kind == NULL || outcome == NULL ||
      forward_count >= sizeof(forward_kind) / sizeof(forward_kind[0])) return 0;
  *kind = forward_kind[forward_count];
  *outcome = forward_outcome[forward_count];
  return 1;
}

static inline int keiko_recovery_restore_expected(
    unsigned int restore_count,
    const char **kind,
    const char **outcome
) {
  static const char *const restore_kind[] = {
      "restore", "restore", "restored-start", "restored-start", "restored-verify",
      "restored-verify"};
  static const char *const restore_outcome[] = {
      "intent", "completed", "intent", "completed", "intent", "completed"};
  if (kind == NULL || outcome == NULL ||
      restore_count >= sizeof(restore_kind) / sizeof(restore_kind[0])) return 0;
  *kind = restore_kind[restore_count];
  *outcome = restore_outcome[restore_count];
  return 1;
}

static inline int keiko_recovery_may_begin_restore(unsigned int forward_count) {
  return forward_count >= 3u && forward_count <= 10u;
}

typedef struct {
  void *context;
  int (*append_receipt)(void *context, const char *kind, const char *outcome);
  int (*restore_platform)(void *context, uint64_t deadline_ms);
  int (*restore_previous)(void *context, uint64_t deadline_ms);
  int (*registration_is_prepared)(void *context, uint64_t deadline_ms);
  int (*cleanup_recovery)(void *context, uint64_t deadline_ms);
} keiko_recovery_engine;

static inline int keiko_recovery_reconcile_engine(
    const keiko_recovery_engine *engine,
    unsigned int forward_count,
    unsigned int restore_count,
    uint64_t deadline_ms
) {
  void *context;
  if (engine == NULL || engine->context == NULL || engine->append_receipt == NULL ||
      engine->restore_platform == NULL || engine->restore_previous == NULL ||
      engine->registration_is_prepared == NULL || engine->cleanup_recovery == NULL) {
    return 0;
  }
  context = engine->context;
  if (restore_count > 0u) {
    if (!engine->restore_platform(context, deadline_ms)) return 0;
    if (restore_count == 1u &&
        !engine->append_receipt(context, "restore", "completed")) {
      return 0;
    }
    return restore_count >= 1u;
  }
  if (forward_count < 2u) return 0;
  if (forward_count == 2u &&
      !engine->append_receipt(context, "old-exit", "completed")) {
    return 0;
  }
  if (forward_count < 9u) return engine->restore_previous(context, deadline_ms);
  if (!engine->registration_is_prepared(context, deadline_ms)) return 0;
  if (forward_count < 11u || forward_count == 14u) return 1;
  if (forward_count == 11u &&
      !engine->append_receipt(context, "cleanup", "intent")) {
    return 0;
  }
  if (forward_count <= 12u) {
    if (!engine->cleanup_recovery(context, deadline_ms) ||
        !engine->append_receipt(context, "cleanup", "completed")) {
      return 0;
    }
  }
  return engine->append_receipt(context, "complete", "completed");
}

#endif
