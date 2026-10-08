'use strict';
var KEYS = { settings: 'electricity.settings.v1', draft: 'electricity.settings-draft.v1', credentials: 'electricity.credentials.v1', cache: 'electricity.cache.v1' };
function Store(storage) { this.storage = storage; }
Store.prototype.read = function(key) {
  try { var value = this.storage.getItem(KEYS[key]); return value ? JSON.parse(value) : null; }
  catch (e) { return null; }
};
Store.prototype.write = function(key, value) { this.storage.setItem(KEYS[key], JSON.stringify(value)); };
Store.prototype.clearSecrets = function() {
  this.storage.removeItem(KEYS.credentials);
  this.storage.removeItem(KEYS.cache);
};
Store.prototype.updateCredentials = function(input) {
  if (input.clearCredentials === true) { this.clearSecrets(); return; }
  var old = this.read('credentials') || {};
  var email = typeof input.email === 'string' ? input.email.trim() : '';
  var password = typeof input.password === 'string' ? input.password : '';
  if (email) { old.email = email; }
  if (password) { old.password = password; }
  if (old.email || old.password) { this.write('credentials', old); }
};
Store.prototype.removeCache = function() { this.storage.removeItem(KEYS.cache); };
Store.prototype.removeSettings = function() { this.storage.removeItem(KEYS.settings); };
Store.prototype.saveDraft = function(input) {
  var draft = {};
  ['month', 'contractStartDate', 'basicMode', 'basicRate', 'rate1', 'rate2', 'bandStart', 'bandEnd',
    'fuelRate', 'governmentRate', 'taxMode', 'taxRate', 'demo'].forEach(function(key) {
    if (input[key] !== undefined) { draft[key] = input[key]; }
  });
  this.write('draft', draft);
};
module.exports = { Store: Store, KEYS: KEYS };
