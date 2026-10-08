#ifndef ELECTRICITY_WATCH_CACHE_H
#define ELECTRICITY_WATCH_CACHE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Compare with persistent data, not live UI state: an unsaved timeout or failed
// write must not prevent a later response from restoring the saved snapshot.
// All current persisted fields fit 64 bytes including their terminating NUL.
static bool watch_cache_save(uint32_t version_key, uint32_t field_base, int version,
                             char *const fields[], const size_t sizes[], unsigned count) {
  bool version_matches = persist_read_int(version_key) == version;
  bool success = true;
  char previous[64];
  for (unsigned i = 0; i < count; ++i) {
    bool matches = false;
    if (version_matches && sizes[i] <= sizeof(previous)) {
      previous[0] = 0;
      previous[sizeof(previous) - 1] = 0;
      matches = persist_read_string(field_base + i, previous, sizes[i]) > 0 &&
                strcmp(previous, fields[i]) == 0;
    }
    if (!matches && persist_write_string(field_base + i, fields[i]) < 0) success = false;
  }
  // On a new or migrated cache, publish the format marker only after all fields
  // were written. Failed fields are compared and retried on the next response.
  if (success && !version_matches && persist_write_int(version_key, version) < 0) success = false;
  return success;
}

#endif
