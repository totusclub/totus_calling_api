const { clampFlexDates, MAX_FLEX_DATES } = require('./search.params.normalizer');

function shiftIsoDate(iso, days) {
  if (!iso) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const LEVEL_PREFACE = {
  1: 'Расширил окно дат для поиска — смотрю соседние варианты вылета.',
  2: 'Снял фильтр по типу питания, чтобы найти больше предложений.',
  3: 'Ищу без ограничения по бюджету — покажу реальные минимальные цены.',
  4: 'Сдвинул дату вылета на неделю вперёд и повторил поиск.',
  5: 'Попробовал максимально широкий поиск по этому направлению.',
};

/**
 * Apply next escalation step when strict search returns nothing or replies loop.
 * Returns { patch, level, preface, exhausted }.
 */
function applyEscalationStep(conversation, params) {
  const meta = conversation.meta || {};
  const current = meta.escalation_level || 0;
  const level = current + 1;
  meta.escalation_level = level;

  const patch = { page_number: 1 };
  let exhausted = false;

  switch (level) {
    case 1:
      patch.flex_dates = clampFlexDates(Math.max(Number(params.flex_dates) || 2, MAX_FLEX_DATES));
      break;
    case 2:
      patch.filter_meals = '';
      break;
    case 3:
      patch.filter_price_max = '';
      break;
    case 4:
      if (params.start_date) {
        patch.start_date = shiftIsoDate(params.start_date, 7);
        patch.start_date_from = patch.start_date;
        if (params.nights) {
          const nights = parseInt(String(params.nights), 10) || 7;
          patch.end_date_till = shiftIsoDate(patch.start_date, nights);
        }
      }
      patch.flex_dates = MAX_FLEX_DATES;
      break;
    default:
      exhausted = true;
      break;
  }

  return {
    patch,
    level,
    preface: LEVEL_PREFACE[level] || LEVEL_PREFACE[5],
    exhausted,
  };
}

function resetEscalation(conversation) {
  if (conversation.meta) {
    conversation.meta.escalation_level = 0;
  }
}

function getEscalationPreface(level) {
  return LEVEL_PREFACE[level] || '';
}

module.exports = {
  applyEscalationStep,
  resetEscalation,
  getEscalationPreface,
  shiftIsoDate,
};
