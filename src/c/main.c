#include <pebble.h>
#include <stdio.h>
#include <string.h>
#include "watch_cache.h"

enum { KEY_STATUS = 0, KEY_CURRENT = 1, KEY_FORECAST = 2, KEY_USAGE = 3,
       KEY_PERIOD = 4, KEY_UPDATED = 5, KEY_DETAIL = 6, KEY_REFRESH = 7, KEY_BREAKDOWN = 8,
       KEY_BAND1 = 9, KEY_BAND2 = 10 };
enum { CACHE_VERSION = 90, CACHE_FIELDS = 100 };
static Window *s_window, *s_details;
static TextLayer *s_state, *s_title, *s_value, *s_date, *s_band_row1, *s_band_row2;
static Layer *s_chrome;
static unsigned s_card;
static char s_display_value[48], s_through[32];
static char s_short_state[80];
static ScrollLayer *s_scroll;
static TextLayer *s_text;
static char s_status[64] = "Waiting for phone";
static char s_current[32] = "--", s_forecast[32] = "--", s_usage[32] = "--";
static char s_period[32] = "--", s_updated[32] = "--", s_detail[64] = "Set rates on your phone";
static char s_breakdown[512] = "--";
static char s_band1[32] = "--", s_band2[32] = "--";
static char s_band_text1[64], s_band_text2[64];
static char s_screen[1800];
static char s_detail_current[48], s_detail_forecast[48];
static bool s_cached, s_demo;
static AppTimer *s_response_timer;
static bool s_refresh_pending;
static void render(void);

static void cancel_response_wait(void) {
  if (s_response_timer) app_timer_cancel(s_response_timer);
  s_response_timer = NULL;
  s_refresh_pending = false;
}

static void response_timeout(void *context) {
  (void)context;
  s_response_timer = NULL;
  s_refresh_pending = false;
  snprintf(s_status, sizeof(s_status), "No reply from phone; SELECT retry");
  s_cached = true;
  render();
}

static void start_response_wait(void) {
  if (!s_response_timer) s_response_timer = app_timer_register(75000, response_timeout, NULL);
}
static char *s_fields[] = { s_status, s_current, s_forecast, s_usage, s_period, s_updated, s_detail, s_band1, s_band2, s_breakdown };
static const size_t s_sizes[] = { 64, 32, 32, 32, 32, 32, 64, 32, 32, 512 };
static const uint32_t s_keys[] = { KEY_STATUS, KEY_CURRENT, KEY_FORECAST, KEY_USAGE, KEY_PERIOD,
                                 KEY_UPDATED, KEY_DETAIL, KEY_BAND1, KEY_BAND2, KEY_BREAKDOWN };

static bool contains(const char *text, const char *word) {
  char lower[128];
  size_t n = strlen(text);
  if (n >= sizeof(lower)) n = sizeof(lower) - 1;
  for (size_t i = 0; i < n; ++i) lower[i] = text[i] >= 'A' && text[i] <= 'Z' ? text[i] + 32 : text[i];
  lower[n] = 0;
  return strstr(lower, word) != NULL;
}

static const char *amount(const char *value) {
  return strncmp(value, "JPY ", 4) == 0 ? value + 4 : value;
}

static void summarize_state(void) {
  bool demo = s_demo || contains(s_status, "demo");
  bool old = s_cached || contains(s_status, "cache") || contains(s_status, "stale");
  bool complete_cache = !s_cached && contains(s_status, "complete cache");
  bool wait = contains(s_status, "updating");
  bool gaps = contains(s_status, "missing") || contains(s_status, "partial") || contains(s_detail, "missing");
  bool late = contains(s_status, "delay") || contains(s_detail, "behind");
  bool no_reply = contains(s_status, "no reply");
  bool offline = contains(s_status, "offline") || contains(s_status, "failed");
  snprintf(s_short_state, sizeof(s_short_state), "%s%s%s%s%s%s",
      demo ? "DEMO" : (complete_cache ? "CACHE" : (no_reply ? "NO REPLY" : (wait ? (old ? "OLD WAIT" : "UPDATING") : (offline ? (old ? "OLD FAIL" : "OFFLINE") : (old ? "OLD DATA" : "ESTIMATE"))))),
      demo ? (complete_cache ? " CACHE" : (no_reply ? " FAIL" : (wait ? " WAIT" : (offline ? " FAIL" : (old ? " OLD" : ""))))) : "", "",
      gaps || late ? "\n" : "", gaps ? "GAPS" : "", late ? (gaps ? " LATE" : "LATE") : "");
}

static void show_amount(const char *value) {
  if (!s_value) return;
  const char *digits = amount(value);
  GFont font = fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD);
  GRect bounds = layer_get_bounds(text_layer_get_layer(s_value));
  GSize natural = graphics_text_layout_get_content_size(digits, font, GRect(0, 0, 1000, 100), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  if (natural.w <= bounds.size.w && natural.h <= bounds.size.h) {
    size_t n = strlen(digits), out = 0;
    for (size_t i = 0; i < n && out + 2 < sizeof(s_display_value); ++i) {
      if (i && (n - i) % 3 == 0 && digits[i-1] != '-') s_display_value[out++] = ',';
      s_display_value[out++] = digits[i];
    }
    s_display_value[out] = 0;
    GSize grouped = graphics_text_layout_get_content_size(s_display_value, font, GRect(0, 0, 1000, 100), GTextOverflowModeWordWrap, GTextAlignmentLeft);
    text_layer_set_font(s_value, font);
    text_layer_set_text(s_value, grouped.w <= bounds.size.w ? s_display_value : digits);
  } else {
    text_layer_set_font(s_value, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
    text_layer_set_text(s_value, "See details");
  }
}

static void through_date(void) {
  const char *through = strstr(s_detail, "Through ");
  if (through && strlen(through + 8) >= 5) snprintf(s_through, sizeof(s_through), "To %.5s", through + 8);
  else snprintf(s_through, sizeof(s_through), "Date: details");
}

static void detail_amount(const char *value, char *output, size_t size) {
  const char *digits = amount(value);
  if (strlen(digits) <= 5) {
    snprintf(output, size, "%s", value);
    return;
  }
  // Explicit digit-only line breaks prevent the SDK adding a hyphen to long numbers.
  size_t written = 0;
  if (strncmp(value, "JPY ", 4) == 0) {
    snprintf(output, size, "JPY\n");
    written = 4;
  }
  for (size_t i = 0; digits[i] && written + 1 < size; ++i) {
    if (i && i % 5 == 0 && written + 2 < size) output[written++] = '\n';
    output[written++] = digits[i];
  }
  output[written] = 0;
}

static void band_text(TextLayer *layer, int band, const char *value, char *output, size_t size) {
  if (!layer) return;
  snprintf(output, size, "Band %d: %s kWh", band, value);
  GRect frame = layer_get_frame(text_layer_get_layer(layer));
  GFont font = fonts_get_system_font(frame.size.h > 20 ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD);
  GSize text = graphics_text_layout_get_content_size(output, font, GRect(0, 0, 1000, 100), GTextOverflowModeWordWrap, GTextAlignmentLeft);
  if (text.w > frame.size.w) snprintf(output, size, "Band %d: details", band);
  text_layer_set_font(layer, font);
  text_layer_set_text(layer, output);
  layer_mark_dirty(text_layer_get_layer(layer));
}

static void summary_layout(bool missing) {
  if (!s_window || !s_title || !s_value || !s_date || !s_band_row1 || !s_band_row2) return;
  GRect bounds = layer_get_bounds(window_get_root_layer(s_window));
  int w = bounds.size.w, h = bounds.size.h;
  bool usage = s_card && !missing;
  bool large = h > 200;
  int width = PBL_IF_ROUND_ELSE(148, w - 8);
  int title_y = usage && !large ? 56 : 59;
  int amount_y = usage && !large ? PBL_IF_ROUND_ELSE(74, 72) : 87;
  layer_set_frame(text_layer_get_layer(s_title), GRect((w-width)/2, title_y, width, 29));
  layer_set_frame(text_layer_get_layer(s_value), GRect((w-width)/2, amount_y, width, missing ? 65 : 49));
  if (usage) {
    int y1 = large ? 139 : PBL_IF_ROUND_ELSE(116, 114);
    int y2 = large ? 166 : PBL_IF_ROUND_ELSE(134, 132);
    int band_h = large ? 27 : 20;
    int width1 = PBL_IF_ROUND_ELSE(140, w-8), width2 = PBL_IF_ROUND_ELSE(120, w-8);
    layer_set_frame(text_layer_get_layer(s_band_row1), GRect((w-width1)/2, y1, width1, band_h));
    layer_set_frame(text_layer_get_layer(s_band_row2), GRect((w-width2)/2, y2, width2, band_h));
    band_text(s_band_row1, 1, s_band1, s_band_text1, sizeof(s_band_text1));
    band_text(s_band_row2, 2, s_band2, s_band_text2, sizeof(s_band_text2));
    int date_width = PBL_IF_ROUND_ELSE(90, w-8);
    layer_set_frame(text_layer_get_layer(s_date), GRect((w-date_width)/2, large ? 195 : PBL_IF_ROUND_ELSE(150, 148), date_width, large ? 29 : 20));
    text_layer_set_font(s_date, fonts_get_system_font(large ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD));
  } else {
    layer_set_frame(text_layer_get_layer(s_date), GRect((w-width)/2, h-39, width, 29));
    text_layer_set_font(s_date, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  }
  if (s_band_row1) layer_set_hidden(text_layer_get_layer(s_band_row1), !usage);
  if (s_band_row2) layer_set_hidden(text_layer_get_layer(s_band_row2), !usage);
}

static void render(void) {
  summarize_state();
  bool missing = !strcmp(s_current, "--") && !strcmp(s_forecast, "--");
  summary_layout(missing);
  bool data_wait = contains(s_detail, "missing") || contains(s_detail, "complete") || contains(s_detail, "no usage");
  bool auth = contains(s_detail, "login") || contains(s_detail, "auth");
  bool network = contains(s_detail, "network") || contains(s_detail, "timeout") || contains(s_detail, "http") || contains(s_status, "offline") || contains(s_status, "failed");
  bool updating = contains(s_status, "updating");
  bool phone_wait = contains(s_status, "waiting for phone");
  bool no_reply = contains(s_status, "no reply");
  if (s_state) text_layer_set_text(s_state, missing ? (no_reply ? "NO REPLY" : (phone_wait ? "PHONE WAIT" : (updating ? (s_demo ? "DEMO WAIT" : "UPDATING") : (network ? (s_demo ? "DEMO FAIL" : "OFFLINE") : (data_wait ? "WAIT DATA" : "NO ESTIMATE"))))) : s_short_state);
  if (s_title) text_layer_set_text(s_title, missing ? ((phone_wait || no_reply) ? "Open Pebble" : (updating ? (contains(s_status, "auth") ? "Signing in" : (contains(s_status, "account") ? "Account data" : (contains(s_status, "usage") ? "Usage data" : "Getting data"))) : (network ? "No connection" : (data_wait ? "Waiting data" : (auth ? "Sign in" : "Check phone"))))) : (s_card ? "So far / JPY" : "Forecast / JPY"));
  if (s_value) {
    GRect frame = layer_get_frame(text_layer_get_layer(s_value));
    frame.size.h = missing ? 65 : 49;
    layer_set_frame(text_layer_get_layer(s_value), frame);
    if (missing) {
      text_layer_set_font(s_value, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
      const char *reason = (phone_wait || no_reply) ? "No phone\nresponse" : (updating ? "Please wait" : "Open phone\nsettings");
      if (!updating && !phone_wait && !no_reply && data_wait) reason = "Need one\ncomplete day";
      else if (!updating && !phone_wait && !no_reply && auth) reason = "Open phone\nlogin";
      else if (!updating && !phone_wait && !no_reply && network) reason = "SELECT:\ntry again";
      text_layer_set_text(s_value, reason);
    } else show_amount(s_card ? s_current : s_forecast);
  }
  through_date();
  if (s_date) {
    layer_set_hidden(text_layer_get_layer(s_date), missing);
    text_layer_set_text(s_date, s_through);
  }
  if (s_chrome) layer_mark_dirty(s_chrome);
  if (!s_text) return;
  detail_amount(s_forecast, s_detail_forecast, sizeof(s_detail_forecast));
  detail_amount(s_current, s_detail_current, sizeof(s_detail_current));
  snprintf(s_screen, sizeof(s_screen),
    "Watch v1.0.8\n%s\n\nPeriod / JST\n%s\n\nMonth end / JPY\n%s\n\nSo far / JPY\n%s\n\nStatus\n%s%s\n\nUsage / kWh\n%s\nBand 1\n%s kWh\nBand 2\n%s kWh\n\nFetched / JST\n%s\n\nBreakdown / JPY\n%s\n\nLong amounts: digits\ncontinue on next line.\nJST calendar month.\nCompleted days only.\nSELECT: refresh\nBACK: summary\nEnd of details\n",
    s_detail, s_period, s_detail_forecast, s_detail_current, s_cached ? "CACHED\n" : "", s_status, s_usage, s_band1, s_band2, s_updated, s_breakdown);
  GRect frame = layer_get_frame(text_layer_get_layer(s_text));
  frame.size.h = 4000;
  layer_set_frame(text_layer_get_layer(s_text), frame);
  text_layer_set_text(s_text, s_screen);
  GSize size = text_layer_get_content_size(s_text);
  frame.size.h = size.h + 32;
  layer_set_frame(text_layer_get_layer(s_text), frame);
  scroll_layer_set_content_size(s_scroll, GSize(frame.size.w, frame.size.h));
}

static void save_cache(void) {
  // Breakdown exceeds one persistent value; persist the nine short fields.
  watch_cache_save(CACHE_VERSION, CACHE_FIELDS, 3, s_fields, s_sizes,
                   ARRAY_LENGTH(s_fields) - 1);
}

static void inbox(DictionaryIterator *iter, void *context) {
  (void)context;
  bool received = false;
  // A legacy full snapshot has no band fields. Do not attach a previous
  // snapshot's usage to its new amount; partial progress messages retain it.
  Tuple *current = dict_find(iter, KEY_CURRENT);
  if (current && current->type == TUPLE_CSTRING && current->length > 0) {
    Tuple *band1 = dict_find(iter, KEY_BAND1), *band2 = dict_find(iter, KEY_BAND2);
    if (!band1 || band1->type != TUPLE_CSTRING || !band1->length) snprintf(s_band1, sizeof(s_band1), "--");
    if (!band2 || band2->type != TUPLE_CSTRING || !band2->length) snprintf(s_band2, sizeof(s_band2), "--");
  }
  for (unsigned i = 0; i < ARRAY_LENGTH(s_fields); ++i) {
    Tuple *tuple = dict_find(iter, s_keys[i]);
    if (tuple && tuple->type == TUPLE_CSTRING && tuple->length > 0) {
      snprintf(s_fields[i], s_sizes[i], "%s", tuple->value->cstring);
      received = true;
    }
  }
  if (received) {
    Tuple *status = dict_find(iter, KEY_STATUS);
    if (status && status->type == TUPLE_CSTRING) s_demo = contains(s_status, "demo");
    if (!contains(s_status, "updating")) cancel_response_wait();
    else start_response_wait();
    // A companion response supplies the state, including stale/error cache descriptions.
    s_cached = false;
    save_cache();
    render();
  }
}

static void connection(bool connected) {
  if (!connected) {
    cancel_response_wait();
    snprintf(s_status, sizeof(s_status), "Offline - phone disconnected");
    s_cached = true;
    render();
  }
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  (void)iter; (void)reason; (void)context;
  cancel_response_wait();
  snprintf(s_status, sizeof(s_status), "Offline - refresh failed");
  s_cached = true;
  render();
}

static void dropped(AppMessageResult reason, void *context) {
  (void)reason; (void)context;
  cancel_response_wait();
  snprintf(s_status, sizeof(s_status), "Phone message failed");
  s_cached = true;
  render();
}

static void refresh(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer; (void)context;
  if (s_refresh_pending) return;
  if (!connection_service_peek_pebble_app_connection()) {
    connection(false);
    return;
  }
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK || !iter) {
    snprintf(s_status, sizeof(s_status), "Refresh busy - try again");
    render();
    return;
  }
  dict_write_uint8(iter, KEY_REFRESH, 1);
  dict_write_end(iter);
  cancel_response_wait();
  start_response_wait();
  s_refresh_pending = true;
  if (app_message_outbox_send() != APP_MSG_OK) {
    outbox_failed(NULL, APP_MSG_BUSY, NULL);
    return;
  }
  snprintf(s_status, sizeof(s_status), "Updating - previous data");
  s_cached = true;
  render();
}

static void detail_click_config(void *context) {
  (void)context;
  window_single_click_subscribe(BUTTON_ID_SELECT, refresh);
}

static void show_details(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer; (void)context;
  if (s_details) window_stack_push(s_details, true);
}

static void next_card(ClickRecognizerRef recognizer, void *context) {
  if (!s_card) { s_card = 1; render(); }
  else show_details(recognizer, context);
}

static void previous_card(ClickRecognizerRef recognizer, void *context) {
  (void)recognizer; (void)context;
  s_card = 0;
  render();
}

static void summary_click_config(void *context) {
  (void)context;
  window_single_click_subscribe(BUTTON_ID_SELECT, refresh);
  window_single_click_subscribe(BUTTON_ID_DOWN, next_card);
  window_single_click_subscribe(BUTTON_ID_UP, previous_card);
}

static TextLayer *make_text(Layer *root, GRect frame, const char *font, const char *text) {
  TextLayer *layer = text_layer_create(frame);
  if (!layer) return NULL;
  text_layer_set_font(layer, fonts_get_system_font(font));
  text_layer_set_text_alignment(layer, GTextAlignmentCenter);
  text_layer_set_text_color(layer, GColorBlack);
  text_layer_set_background_color(layer, GColorWhite);
  text_layer_set_overflow_mode(layer, GTextOverflowModeWordWrap);
  text_layer_set_text(layer, text);
  layer_add_child(root, text_layer_get_layer(layer));
  return layer;
}

static void draw_chrome(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  graphics_context_set_fill_color(ctx, GColorBlack);
  bool compact = s_card && bounds.size.h <= 200 && strcmp(s_current, "--");
  graphics_fill_rect(ctx, GRect(0, 0, bounds.size.w, compact ? 56 : 58), 0, GCornerNone);
  graphics_context_set_stroke_color(ctx, GColorBlack);
  int x = PBL_IF_ROUND_ELSE(bounds.size.w / 2, s_card ? bounds.size.w - 10 : bounds.size.w / 2);
  int y = bounds.size.h - PBL_IF_ROUND_ELSE(8, 12);
  for (int i = 0; i < 5; ++i) graphics_draw_line(ctx, GPoint(x-5+i, y+i), GPoint(x+5-i, y+i));
}

static void load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  int w = bounds.size.w, h = bounds.size.h;
  int width = PBL_IF_ROUND_ELSE(148, w - 8);
  s_chrome = layer_create(bounds);
  if (s_chrome) { layer_set_update_proc(s_chrome, draw_chrome); layer_add_child(root, s_chrome); }
  s_state = make_text(root, GRect((w-width)/2, PBL_IF_ROUND_ELSE(4, 0), width, 50), FONT_KEY_GOTHIC_24_BOLD, "");
  if (s_state) { text_layer_set_background_color(s_state, GColorClear); text_layer_set_text_color(s_state, GColorWhite); }
  s_title = make_text(root, GRect((w-width)/2, 59, width, 29), FONT_KEY_GOTHIC_24_BOLD, "");
  s_value = make_text(root, GRect((w-width)/2, 87, width, 49), FONT_KEY_BITHAM_42_BOLD, "");
  s_date = make_text(root, GRect((w-width)/2, h-39, width, 29), FONT_KEY_GOTHIC_24_BOLD, "");
  s_band_row1 = make_text(root, GRect(4, 139, w-8, 27), FONT_KEY_GOTHIC_24_BOLD, "");
  s_band_row2 = make_text(root, GRect(4, 166, w-8, 27), FONT_KEY_GOTHIC_24_BOLD, "");
  // Compact cards share TextLayer frame padding; transparent backgrounds keep
  // one row's padding from erasing another row's visible glyphs.
  if (s_value) text_layer_set_background_color(s_value, GColorClear);
  if (s_date) text_layer_set_background_color(s_date, GColorClear);
  if (s_band_row1) text_layer_set_background_color(s_band_row1, GColorClear);
  if (s_band_row2) text_layer_set_background_color(s_band_row2, GColorClear);
  render();
}

static void destroy_text(TextLayer **layer) {
  if (*layer) text_layer_destroy(*layer);
  *layer = NULL;
}

static void unload(Window *window) {
  (void)window;
  destroy_text(&s_state); destroy_text(&s_title); destroy_text(&s_value); destroy_text(&s_date);
  destroy_text(&s_band_row1); destroy_text(&s_band_row2);
  if (s_chrome) layer_destroy(s_chrome);
  s_chrome = NULL;
}

static void details_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  GRect viewport = PBL_IF_ROUND_ELSE(bounds, GRect(4, 0, bounds.size.w - 8, bounds.size.h));
  s_scroll = scroll_layer_create(viewport);
  if (!s_scroll) return;
  scroll_layer_set_callbacks(s_scroll, (ScrollLayerCallbacks) { .click_config_provider = detail_click_config });
  scroll_layer_set_click_config_onto_window(s_scroll, window);
  s_text = text_layer_create(GRect(0, 0, viewport.size.w, 4000));
  if (!s_text) { scroll_layer_destroy(s_scroll); s_scroll = NULL; return; }
  text_layer_set_font(s_text, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_text, GTextAlignmentCenter);
  text_layer_set_text_color(s_text, GColorBlack);
  text_layer_set_background_color(s_text, GColorWhite);
  text_layer_set_overflow_mode(s_text, GTextOverflowModeWordWrap);
  scroll_layer_add_child(s_scroll, text_layer_get_layer(s_text));
  layer_add_child(root, scroll_layer_get_layer(s_scroll));
#ifdef PBL_ROUND
  text_layer_enable_screen_text_flow_and_paging(s_text, 4);
#endif
  render();
}

static void details_unload(Window *window) {
  (void)window;
  destroy_text(&s_text);
  if (s_scroll) scroll_layer_destroy(s_scroll);
  s_scroll = NULL;
}

static void init(void) {
  int cache_version = persist_read_int(CACHE_VERSION);
  if (cache_version == 2 || cache_version == 3) {
    unsigned count = cache_version == 2 ? 7 : ARRAY_LENGTH(s_fields) - 1;
    for (unsigned i = 0; i < count; ++i) {
      persist_read_string(CACHE_FIELDS + i, s_fields[i], s_sizes[i]);
    }
    s_demo = contains(s_status, "demo");
    snprintf(s_status, sizeof(s_status), s_demo ? "DEMO - waiting for phone update" : "Waiting for phone update");
    s_cached = true;
  }
  app_message_register_inbox_received(inbox);
  app_message_register_inbox_dropped(dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(1024, 64);
  connection_service_subscribe((ConnectionHandlers) { .pebble_app_connection_handler = connection });
  s_window = window_create();
  if (!s_window) return;
  window_set_background_color(s_window, GColorWhite);
  window_set_click_config_provider(s_window, summary_click_config);
  s_details = window_create();
  if (s_details) {
    window_set_background_color(s_details, GColorWhite);
    window_set_window_handlers(s_details, (WindowHandlers) { .load = details_load, .unload = details_unload });
  }
  window_set_window_handlers(s_window, (WindowHandlers) { .load = load, .unload = unload });
  window_stack_push(s_window, true);
  if (!connection_service_peek_pebble_app_connection()) connection(false);
  if (connection_service_peek_pebble_app_connection()) start_response_wait();
  // One response deadline only; the companion owns fetch and there is no automatic retry.
}

static void deinit(void) {
  cancel_response_wait();
  connection_service_unsubscribe();
  app_message_deregister_callbacks();
  if (s_details) window_destroy(s_details);
  if (s_window) window_destroy(s_window);
}

int main(void) { init(); app_event_loop(); deinit(); }
