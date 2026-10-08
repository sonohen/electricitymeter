#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static char saved[9][64];
static bool present[9];
static int marker, writes, reads, fail_field = -1, fail_read = -1;
static bool fail_marker;
static int persist_read_int(uint32_t key) { assert(key == 90); return marker; }
static int persist_read_string(uint32_t key, char *out, size_t size) {
  unsigned i = key - 100; assert(i < 9); reads++;
  if (!present[i] || (int)i == fail_read) return -1;
  snprintf(out, size, "%s", saved[i]);
  return (int)strlen(out) + 1;
}
static int persist_write_string(uint32_t key, const char *value) {
  unsigned i = key - 100; assert(i < 9); writes++;
  if ((int)i == fail_field) return -1;
  assert(strlen(value) < sizeof(saved[i]));
  strcpy(saved[i], value); present[i] = true;
  return (int)strlen(value) + 1;
}
static int persist_write_int(uint32_t key, int value) {
  assert(key == 90); writes++;
  if (fail_marker) return -1;
  marker = value; return 4;
}
#include "../src/c/watch_cache.h"

static char status[64] = "Estimate", current[32] = "JPY 149", forecast[32] = "JPY 4315";
static char usage[32] = "5 kWh", period[32] = "10/03-10/03 / 1 day", updated[32] = "10/04 00:19 JST", detail[64] = "From 10/03; Through 10/03";
static char band1[32]="2.00",band2[32]="3.00";
static char *fields[] = {status,current,forecast,usage,period,updated,detail,band1,band2};
static size_t sizes[] = {64,32,32,32,32,32,64,32,32};
static unsigned field_count=7;
static int format=2;
static bool save(void) { return watch_cache_save(90,100,format,fields,sizes,field_count); }
static void counts(void) { writes = reads = 0; }
static void reset(void) { memset(present,0,sizeof(present));marker=0;fail_field=fail_read=-1;fail_marker=false;counts(); }
int main(void) {
  reset();assert(save());assert(writes==8 && marker==2);
  counts();assert(save());assert(writes==0 && reads==7);
  strcpy(status,"Updating / AUTH");strcpy(detail,"Phone: AUTH");
  counts();assert(save());assert(writes==2);
  // Restore terminal state, preserving all fields on a simulated restart.
  strcpy(status,"Estimate");strcpy(detail,"From 10/03; Through 10/03");
  counts();assert(save());assert(writes==2);
  for(unsigned i=0;i<7;i++) { char restored[64];assert(persist_read_string(100+i,restored,64)>0);assert(!strcmp(restored,fields[i])); }
  // Equal amount with new date, period and quality must not be deduplicated.
  strcpy(updated,"10/05 00:19 JST");strcpy(period,"10/03-10/04 / 2 days");strcpy(detail,"Through 10/04; missing 10/05");strcpy(status,"Estimate / missing");
  counts();assert(save());assert(writes==4);
  memset(detail,'x',63);detail[63]=0;counts();assert(save());assert(writes==1);assert(strlen(saved[6])==63);
  counts();assert(save());assert(writes==0);
  detail[62]='y';counts();assert(save());assert(writes==1);assert(saved[6][62]=='y');
  // Failed same-version fields are retried using persistent truth, not RAM.
  strcpy(current,"--");fail_field=1;counts();assert(!save());assert(writes==1);assert(strcmp(saved[1],"--"));
  fail_field=-1;counts();assert(save());assert(writes==1);assert(!strcmp(saved[1],"--"));
  // Failed reads and missing keys cannot masquerade as a match.
  fail_read=2;counts();assert(save());assert(writes==1);fail_read=-1;
  present[3]=false;counts();assert(save());assert(writes==1);
  // New or migrated formats publish a marker only after all data succeeds.
  marker=1;fail_field=4;counts();assert(!save());assert(writes==7 && marker==1);
  fail_field=-1;counts();assert(save());assert(writes==8 && marker==2);
  reset();fail_marker=true;assert(!save());assert(writes==8 && marker==0);
  fail_marker=false;counts();assert(save());assert(writes==8 && marker==2);
  counts();assert(save());assert(writes==0);
  // Error terminal state empties values and survives restore.
  strcpy(status,"Unavailable");strcpy(current,"--");strcpy(forecast,"--");strcpy(detail,"Check supply start date");
  counts();assert(save());assert(!strcmp(saved[0],"Unavailable") && !strcmp(saved[2],"--"));
  // Upgrade a real seven-field v2 snapshot: new fields may partially succeed,
  // but its marker remains 2 so startup reads only the legacy seven fields.
  format=3;field_count=9;fail_field=8;counts();
  assert(!save());assert(writes==9 && marker==2);assert(present[7] && !present[8]);
  for(unsigned i=0;i<7;i++) assert(!strcmp(saved[i],fields[i]));
  fail_field=-1;counts();assert(save());assert(writes==10 && marker==3);
  assert(!strcmp(saved[7],"2.00") && !strcmp(saved[8],"3.00"));
  counts();assert(save());assert(writes==0 && reads==9);
  // Same price/period and equal total usage cannot hide changed band makeup.
  strcpy(band1,"3.00");strcpy(band2,"2.00");counts();assert(save());assert(writes==2);
  for(unsigned i=0;i<9;i++) {char restored[64];assert(persist_read_string(100+i,restored,64)>0);assert(!strcmp(restored,fields[i]));}
  reset();fail_marker=true;assert(!save());assert(writes==10 && marker==0);
  fail_marker=false;counts();assert(save());assert(writes==10 && marker==3);
  puts("PASS actual C cache helper: duplicate, progress, semantic change, boundary, retry, migration and restore");
}
