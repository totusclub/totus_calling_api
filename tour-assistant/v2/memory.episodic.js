const { ensureMeta } = require('./conversation.health');

function savePreference(conversation, key, value, confidence = 0.85) {
  if (value === undefined || value === null || value === '') return;
  ensureMeta(conversation);
  conversation.semantic.preferences[key] = {
    value,
    confidence,
    updatedAt: new Date().toISOString(),
  };
}

function savePreferencesFromPatch(conversation, patch = {}) {
  if (patch.from_city) savePreference(conversation, 'default_from_city', patch.from_city);
  if (patch.filter_meals) savePreference(conversation, 'meal_preference', patch.filter_meals);
  if (patch.filter_price_max) {
    savePreference(conversation, 'budget_soft_max', patch.filter_price_max, 0.7);
  }
  if (patch.to_country) {
    savePreference(
      conversation,
      'last_destination_country',
      patch.to_country,
      0.6,
    );
  }
}

/**
 * Apply low-confidence defaults only for empty fields during collection.
 */
function applySemanticDefaults(params, conversation) {
  const prefs = conversation?.semantic?.preferences || {};
  const p = { ...params };

  if (!p.from_city && prefs.default_from_city?.value) {
    p.from_city = prefs.default_from_city.value;
  }
  if (!p.filter_meals && prefs.meal_preference?.value && prefs.meal_preference.confidence >= 0.8) {
    // only suggest during collection, don't auto-apply before user confirms meals field
  }

  return p;
}

function clearDestinationParams(params) {
  const p = { ...params };
  delete p.to_country;
  delete p.to_city;
  delete p.destination_label;
  delete p.destination_label_prep;
  delete p.hotel_name;
  p.hotel_ids = [];
  delete p.filter_price_max;
  delete p.filter_meals;
  delete p.filter_rating_min;
  delete p.filter_stars;
  p.search_intent = 'package';
  p.search_type = 'package';
  p.page_number = 1;
  return p;
}

/**
 * Fix corrupted from_city (e.g. Paris appeared without user intent).
 */
function sanitizeFromCity(params, userText) {
  const p = { ...params };
  const t = (userText || '').toLowerCase();
  const mentionsParis =
    t.includes('париж') || t.includes('paris') || t.includes('франц');
  if (p.from_city === 'Paris' && !mentionsParis) {
    p.from_city = 'Moscow';
    p.from_country = 'RU';
  }
  return p;
}

module.exports = {
  savePreference,
  savePreferencesFromPatch,
  applySemanticDefaults,
  clearDestinationParams,
  sanitizeFromCity,
};
