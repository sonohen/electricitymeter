'use strict';

var HALF_HOUR = 1800000;
var DAY = 86400000;
var JST = 9 * 3600000;

function fail(code) { var e = new Error(code); e.code = code; throw e; }
function number(value, signed) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') { fail('settings'); }
  var n = Number(value);
  if (!isFinite(n) || (!signed && n < 0)) { fail('settings'); }
  return n;
}
function monthInfo(now) {
  var d = new Date(now + JST);
  var year = d.getUTCFullYear(), month = d.getUTCMonth();
  var start = Date.UTC(year, month, 1) - JST;
  var end = Date.UTC(year, month + 1, 1) - JST;
  return { month: year + '-' + ('0' + (month + 1)).slice(-2), start: start, end: end,
    days: (end - start) / DAY, today: Math.floor((now - start) / DAY),
    midnight: Date.UTC(year, month, d.getUTCDate()) - JST };
}
function validate(input, month) {
  if (!input || input.month !== month) { fail('month'); }
  if (['month', 'day'].indexOf(input.basicMode) < 0 ||
      ['included', 'excluded'].indexOf(input.taxMode) < 0) { fail('settings'); }
  var start = timeOfDay(input.bandStart), end = timeOfDay(input.bandEnd);
  if (start === end) { fail('settings'); }
  var contractStartDate = input.contractStartDate == null ? '' : input.contractStartDate;
  if (typeof contractStartDate !== 'string') { fail('contract_date'); }
  contractStartDate = contractStartDate.trim();
  contractStart(contractStartDate);
  return { month: input.month, basicMode: input.basicMode, basicRate: number(input.basicRate),
    contractStartDate: contractStartDate,
    bandStart: input.bandStart, bandEnd: input.bandEnd, rate1: number(input.rate1), rate2: number(input.rate2),
    fuelRate: number(input.fuelRate, true), governmentRate: number(input.governmentRate),
    taxMode: input.taxMode, taxRate: number(input.taxRate) };
}
function contractStart(text) {
  if (!text) { return null; }
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) { fail('contract_date'); }
  var ms = Date.parse(text + 'T00:00:00+09:00');
  if (!isFinite(ms) || new Date(ms + JST).toISOString().slice(0, 10) !== text) { fail('contract_date'); }
  return ms;
}
function collectionStart(info, settings) {
  var start = contractStart(settings.contractStartDate);
  return start === null ? info.start : Math.max(info.start, start);
}
function timeOfDay(text) {
  if (typeof text !== 'string' || !/^([01]\d|2[0-3]):(00|30)$/.test(text)) { fail('settings'); }
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
}
function bandAt(ms, settings) {
  var d = new Date(ms + JST), minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  var start = timeOfDay(settings.bandStart), end = timeOfDay(settings.bandEnd);
  return (start < end ? minute >= start && minute < end : minute >= start || minute < end) ? 0 : 1;
}
function charge(bands, days, monthDays, s) {
  if (!Array.isArray(bands) || bands.length !== 2) { fail('calculation'); }
  var first = number(bands[0]), second = number(bands[1]), kwh = first + second;
  days = number(days); monthDays = number(monthDays);
  if (!monthDays || days > monthDays) { fail('calculation'); }
  var basic = 6 * s.basicRate * (s.basicMode === 'day' ? days : days / monthDays);
  var energy = first * s.rate1 + second * s.rate2;
  var fuel = kwh * s.fuelRate, government = -kwh * s.governmentRate, renewable = kwh * 4.18;
  var beforeTax = basic + energy + fuel + government + renewable;
  var tax = s.taxMode === 'excluded' ? beforeTax * s.taxRate / 100 : 0;
  var total = beforeTax + tax;
  if (!isFinite(total) || total < 0 || total > 9007199254740991) { fail('calculation'); }
  // Remove machine epsilon at integer boundaries, without rounding intermediate charges.
  var nearest = Math.round(total);
  if (Math.abs(total - nearest) < Math.max(1, Math.abs(total)) * 2.220446049250313e-16 * 4) { total = nearest; }
  return { total: Math.ceil(total), basic: basic, energy: energy, fuel: fuel, government: government,
    renewable: renewable, tax: tax, kwh: kwh, bandCharge1: first * s.rate1, bandCharge2: second * s.rate2 };
}
function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value)) { fail('data'); }
  var result = Date.parse(value);
  if (!isFinite(result)) { fail('data'); }
  return result;
}
function aggregate(readings, now, settings) {
  var info = monthInfo(now), startDate = collectionStart(info, settings);
  if (startDate > info.midnight) { fail('not_started'); }
  if (startDate === info.midnight) { fail('insufficient'); }
  var slots = {}, latest = startDate, conflicts = 0, invalidDays = {}, invalidSlots = 0;
  if (!Array.isArray(readings) || !readings.length) { fail('no_data'); }
  readings.forEach(function(r) {
    if (!r || typeof r !== 'object') { fail('data'); }
    var start = timestamp(r.startAt);
    if (start < startDate || start >= now) { return; }
    var dayStart = info.start + Math.floor((start - info.start) / DAY) * DAY;
    var end, value;
    try {
      end = timestamp(r.endAt);
      if (end > now) { return; }
      if (end - start !== HALF_HOUR || (start - info.start) % HALF_HOUR !== 0) { fail('data'); }
      value = number(r.value);
    } catch (e) {
      invalidDays[dayStart] = true; invalidSlots++;
      latest = Math.max(latest, start + HALF_HOUR);
      return;
    }
    var version = r.version == null ? '' : String(r.version);
    if (slots[start] && (slots[start].value !== value)) {
      if (!slots[start].conflict) { conflicts++; }
      slots[start].conflict = true;
    } else if (!slots[start]) { slots[start] = { value: value, version: version }; }
    latest = Math.max(latest, end);
  });
  var lastPositive = startDate, inferredZeroSlots = 0;
  Object.keys(slots).forEach(function(key) {
    var slot = slots[key];
    if (!slot.conflict && slot.value > 0) { lastPositive = Math.max(lastPositive, Number(key)); }
  });
  var completeEnd = startDate, bands = [0, 0], missingSlots = 0;
  // User policy: an absent interval before later positive usage is inferred zero.
  // Today supplies evidence only; malformed/conflicting records are never repaired.
  for (var day = startDate; day < info.midnight; day += DAY) {
    var dayBands = [0, 0], dayInferred = 0, complete = !invalidDays[day];
    for (var t = day; t < day + DAY; t += HALF_HOUR) {
      if (!slots[t] && t < lastPositive) { dayInferred++; }
      else if (!slots[t] || slots[t].conflict) { complete = false; missingSlots++; }
      else { dayBands[bandAt(t, settings)] += slots[t].value; }
    }
    if (complete && completeEnd === day) {
      completeEnd += DAY;
      inferredZeroSlots += dayInferred;
      bands[0] += dayBands[0]; bands[1] += dayBands[1];
    }
  }
  var observedDays = (completeEnd - startDate) / DAY;
  var missing = completeEnd < info.midnight && latest > completeEnd;
  if (!observedDays) { fail(invalidDays[startDate] ? 'data' : (conflicts ? 'conflict' : (missing ? 'missing' : 'insufficient'))); }
  var kwh = bands[0] + bands[1];
  if (!isFinite(kwh)) { fail('data'); }
  var forecastDays = (info.end - startDate) / DAY;
  return { month: info.month, kwh: kwh, days: observedDays, monthDays: info.days, forecastDays: forecastDays,
    end: completeEnd, start: startDate, delayed: completeEnd < info.midnight,
    inferredZeroSlots: inferredZeroSlots, missing: missing, missingSlots: missingSlots, conflicts: conflicts, invalidSlots: invalidSlots,
    firstMissingDay: completeEnd < info.midnight ? completeEnd : null,
    lagDays: (info.midnight - completeEnd) / DAY,
    bands: bands, forecastBands: [bands[0] / observedDays * forecastDays, bands[1] / observedDays * forecastDays],
    forecastKwh: kwh / observedDays * forecastDays };
}
function estimate(readings, input, now) {
  var info = monthInfo(now), s = validate(input, info.month), observed = aggregate(readings, now, s);
  return { observed: observed, current: charge(observed.bands, observed.days, info.days, s),
    forecast: charge(observed.forecastBands, observed.forecastDays, info.days, s) };
}
function demoReadings(now) {
  var info = monthInfo(now), end = info.midnight, result = [];
  for (var t = info.start; t < end; t += HALF_HOUR) {
    result.push({ startAt: new Date(t).toISOString(), endAt: new Date(t + HALF_HOUR).toISOString(),
      value: 0.15, version: 'demo' });
  }
  return result;
}
module.exports = { number: number, monthInfo: monthInfo, validate: validate, charge: charge, bandAt: bandAt,
  collectionStart: collectionStart,
  aggregate: aggregate, estimate: estimate, demoReadings: demoReadings, DAY: DAY, HALF_HOUR: HALF_HOUR };
