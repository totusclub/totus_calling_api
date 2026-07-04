const META_PHRASES =
  /^(я\s+)?(сейчас\s+)?(ищу|подбираю|нахожу|looking|searching|let me|i will|сейчас ищу|начинаю поиск)/i;

const {
  formatDestinationSummary,
  formatDestinationInPhrase,
  formatDestinationPoPhrase,
  formatPackageResultInPhrase,
  formatDateRu,
  syncDestinationLabels,
  isHotelSearch: isHotelDestinationSearch,
  isPackageSearchParams,
} = require('./destination.labels');
const { normalizeSearchParamsForApi } = require('./search.params.normalizer');

function stripMetaLanguage(text) {
  if (!text || typeof text !== 'string') return '';
  let clean = text.trim();
  if (META_PHRASES.test(clean)) return '';
  clean = clean
    .replace(/ищу\s+подходящие\s+отели[^.!?]*/gi, '')
    .replace(/подбираю\s+варианты[^.!?]*/gi, '')
    .replace(/сейчас\s+ищу[^.!?]*/gi, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .trim();
  return clean;
}

function getDestinationLabel(params) {
  if (isHotelDestinationSearch(params) && params.hotel_name) {
    return String(params.hotel_name).trim();
  }
  return formatDestinationSummary(params);
}

function isPackageSearch(params) {
  return (
    params?.search_type === 'package' ||
    params?.search_intent === 'package' ||
    (!params?.hotel_ids?.length && !params?.hotel_name && !params?.search_type)
  );
}

const LIMITED_PACKAGE_COUNTRIES = new Set([
  'FR',
  'DE',
  'AT',
  'CH',
  'NL',
  'BE',
  'CZ',
  'PL',
  'GB',
  'IT',
  'ES',
  'PT',
]);

function isLimitedPackageDestination(params) {
  if (!isPackageSearch(params)) return false;
  const country = String(params?.to_country || '').toUpperCase();
  return LIMITED_PACKAGE_COUNTRIES.has(country);
}

function composeLimitedCatalogAdvice(params) {
  const dest = formatDestinationPoPhrase(params);
  return [
    `Пакетных туров из Москвы в ${dest} сейчас нет в каталоге Totus — для многих европейских направлений это обычная ситуация.`,
    '',
    'Могу помочь по-другому:',
    '• Рассказать, что посмотреть и чем заняться (достопримечательности, районы, сезон)',
    '• Подобрать другое направление с готовыми турами (Турция, Египет, ОАЭ, Таиланд, Индонезия)',
    '• Поискать только отель, если перелёт уже организован',
    '',
    'Что вам ближе — информация о направлении или подбор другой страны?',
  ].join('\n');
}

function pluralizeRu(count, forms) {
  const n = Math.abs(Number(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function getSearchDestinationLabel(params) {
  const p = params || {};
  if (isPackageSearchParams(p) && !isHotelDestinationSearch(p)) {
    return formatPackageResultInPhrase(p);
  }
  return formatDestinationInPhrase(p);
}

function sanitizeParamsForUserMessage(params) {
  return syncDestinationLabels(normalizeSearchParamsForApi(params || {}));
}

/** «— вылет 19 августа» tail so the client always sees the actual date. */
function formatDepartureTail(params) {
  const dateRu = formatDateRu(params?.start_date);
  return dateRu ? ` — вылет ${dateRu}` : '';
}

function formatCheapestTail(hotels) {
  const prices = (hotels || [])
    .map((h) => Number(h.room_price ?? h.min_price ?? (h.hotel || {}).min_price))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!prices.length) return '';
  return `, от ${Math.round(Math.min(...prices)).toLocaleString('ru-RU')} ₽`;
}

function composeResultsCountMessage(params, count, { isPagination = false, hotels = [] } = {}) {
  if (count <= 0) {
    return isPagination
      ? 'Больше вариантов по этим параметрам нет — могу предложить другие даты или направление.'
      : null;
  }

  const isPackage = isPackageSearch(params);
  const label = pluralizeRu(
    count,
    isPackage ? ['тур', 'тура', 'туров'] : ['отель', 'отеля', 'отелей'],
  );
  const prefix = isPagination ? 'Нашёл ещё' : 'Нашёл';
  const dest = getSearchDestinationLabel(params);
  const destPart = dest ? ` в ${dest}` : '';
  return `${prefix} ${count} ${label}${destPart}${formatDepartureTail(params)}${formatCheapestTail(hotels)}.`;
}

function composeRatingFilterResultMessage(params, count, { isPagination = false, ratingFallback = false, hotels = [] } = {}) {
  if (count <= 0) return null;

  const requested = params.filter_rating_min
    ? Number(params.filter_rating_min).toFixed(1)
    : null;
  const label = pluralizeRu(count, ['тур', 'тура', 'туров']);
  const prefix = isPagination ? 'Нашёл ещё' : 'Нашёл';
  const dest = getSearchDestinationLabel(params);
  const destPart = dest ? ` в ${dest}` : '';
  const dateTail = formatDepartureTail(params);

  if (ratingFallback && requested) {
    return `Точных отелей с рейтингом ${requested} не нашёл — показываю лучшие по рейтингу. ${prefix} ${count} ${label}${destPart}${dateTail}.`;
  }
  if (requested) {
    return `${prefix} ${count} ${label} с рейтингом от ${requested}${destPart}${dateTail}.`;
  }
  return composeResultsCountMessage(params, count, { isPagination, hotels });
}

function composeHotelSearchResultMessage(params, hotels, { isPagination = false } = {}) {
  const count = hotels?.length || 0;
  if (count <= 0) return null;

  const name =
    hotels?.[0]?.hotel?.name ||
    hotels?.[0]?.name ||
    params.hotel_name ||
    'отелю';
  const prefix = isPagination ? 'Нашёл ещё' : 'Нашёл';
  const dateTail = formatDepartureTail(params);

  if (count === 1) {
    return `${prefix} тур по отелю ${name}${dateTail}${formatCheapestTail(hotels)}.`;
  }

  const label = pluralizeRu(count, ['тур', 'тура', 'туров']);
  return `${prefix} ${count} ${label} по отелю ${name}${dateTail}${formatCheapestTail(hotels)}.`;
}

function composeResultsIntro(params, hotels, {
  isPagination = false,
  isHotelSearch = false,
  ratingFallback = false,
  hotelOverBudget = false,
  actualMinPrice = null,
} = {}) {
  const count = hotels?.length || 0;
  const hasRatingFilter = Number(params.filter_rating_min) > 0;

  if (hotelOverBudget && count > 0 && actualMinPrice) {
    const budget = params.filter_price_max
      ? Number(params.filter_price_max).toLocaleString('ru-RU')
      : null;
    const intro = composeHotelSearchResultMessage(params, hotels, { isPagination }) ||
      composeResultsCountMessage(params, count, { isPagination, hotels });
    return [
      `Минимальная цена — от ${Math.round(actualMinPrice).toLocaleString('ru-RU')} ₽${budget ? ` (ваш бюджет до ${budget} ₽)` : ''}.`,
      intro,
    ].join(' ');
  }

  if (hasRatingFilter && count > 0) {
    return composeRatingFilterResultMessage(params, count, { isPagination, ratingFallback, hotels });
  }

  if (isPagination) {
    if (isHotelSearch && count > 0) {
      return composeHotelSearchResultMessage(params, hotels, { isPagination: true });
    }
    const countMessage = composeResultsCountMessage(params, count, { isPagination: true, hotels });
    if (countMessage) return countMessage;
  }

  if (count > 0 && isHotelSearch) {
    return composeHotelSearchResultMessage(params, hotels, { isPagination: false });
  }

  if (count > 0) {
    const countMessage = composeResultsCountMessage(params, count, { isPagination: false, hotels });
    if (countMessage) return countMessage;
  }

  if (isHotelSearch) {
    const name = hotels?.[0]?.hotel?.name || hotels?.[0]?.name || params.hotel_name || 'отель';
    if (count === 0) {
      return `По запросу «${name}» сейчас нет доступных туров. Могу подобрать похожие отели в том же районе.`;
    }
  }

  const dest = getDestinationLabel(params);
  if (count === 0) {
    return dest
      ? `По ${dest} сейчас нет туров в указанных параметрах. Попробуйте сдвинуть даты или расширить бюджет — подскажу альтернативы.`
      : 'По этим параметрам вариантов пока нет. Уточните даты или направление — подберу альтернативу.';
  }

  return composeResultsCountMessage(params, count, { isPagination: false, hotels });
}

function composeNoResultsAdvice(params, {
  triedRelaxed = false,
  budgetExceeded = false,
  ratingMinExceeded = false,
  hotelOverBudget = false,
  actualMinPrice = null,
  catalogLimited = false,
  mealFilterBlocked = false,
} = {}) {
  const dest = formatDestinationPoPhrase(params);
  const dateRu = formatDateRu(params?.start_date);
  const budget = params.filter_price_max
    ? Number(params.filter_price_max).toLocaleString('ru-RU')
    : null;
  const ratingMin = params.filter_rating_min
    ? Number(params.filter_rating_min).toFixed(1)
    : null;
  const mealCode = String(params.filter_meals || '').toUpperCase();

  if (catalogLimited || isLimitedPackageDestination(params)) {
    return composeLimitedCatalogAdvice(params);
  }

  if (budgetExceeded && budget && hotelOverBudget && actualMinPrice) {
    const hotelName = params.hotel_name || 'этому отелю';
    return [
      `По ${hotelName} минимальная цена сейчас от ${Math.round(actualMinPrice).toLocaleString('ru-RU')} ₽ — это выше вашего бюджета до ${budget} ₽.`,
      'Могу сдвинуть даты или увеличить бюджет — что попробуем?',
    ].join('\n');
  }

  if (budgetExceeded && budget) {
    return [
      `К сожалению, по ${dest} сейчас нет туров в пределах бюджета до ${budget} ₽.`,
      'Могу сдвинуть даты, предложить соседний курорт или увеличить бюджет — что попробуем?',
    ].join('\n');
  }

  if (ratingMinExceeded && ratingMin) {
    return [
      `К сожалению, по ${dest} сейчас нет туров с рейтингом от ${ratingMin}.`,
      'Могу показать отели с рейтингом от 9.0 или ослабить другие фильтры — что попробуем?',
    ].join('\n');
  }

  if (mealFilterBlocked && (mealCode === 'UAI' || mealCode === 'AI')) {
    const mealLabel = mealCode === 'UAI' ? 'ультра всё включено' : 'всё включено';
    const datePart = dateRu ? ` на вылет ${dateRu}` : '';
    return [
      `По ${dest}${datePart} нет туров с питанием «${mealLabel}».`,
      'Могу показать варианты с другим типом питания или сдвинуть даты — что попробуем?',
    ].join('\n');
  }

  const datePart = dateRu ? ` на вылет ${dateRu}` : '';
  const lines = [
    `К сожалению, по ${dest}${datePart} сейчас нет подходящих туров.`,
  ];

  if (!triedRelaxed) {
    lines.push('Могу предложить:');
    lines.push('• Сдвинуть даты вылета на неделю');
    lines.push('• Рассмотреть соседние курорты');
    lines.push('• Подобрать отели другого класса');
  } else {
    lines.push('Попробуйте другие даты или соседний курорт — напишите, что важнее: цена, звёзды или пляж.');
  }

  return lines.join('\n');
}

function formatHotelLine(hotel, index) {
  const data = hotel.hotel || hotel;
  const name = data.name || data.name_en || 'Отель';
  const city = data.city_name || '';
  const stars = data.stars ? `${data.stars}★` : '';
  const rating = data.rating ? `, рейтинг ${Number(data.rating).toFixed(1)}` : '';
  const price = hotel.room_price || hotel.min_price || data.min_price;
  const priceStr = price ? ` — ${Math.round(price).toLocaleString('ru-RU')} ₽` : '';

  const roomType = hotel.room_type ? ` · ${hotel.room_type}` : '';
  const mealType = hotel.meal_type ? ` · ${hotel.meal_type}` : '';

  const amenities = (Array.isArray(data.features)
    ? data.features
    : Array.isArray(data.amenities)
      ? data.amenities
      : []
  )
    .slice(0, 2)
    .map((a) => (typeof a === 'string' ? a : a?.name || a?.title))
    .filter(Boolean);
  const amenityStr = amenities.length ? ` · ${amenities.join(', ')}` : '';

  return `${index + 1}. ${name}${city ? `, ${city}` : ''}${stars ? ` (${stars}${rating})` : rating}${roomType}${mealType}${priceStr}${amenityStr}`;
}

function composeResultsText(params, hotels, options = {}) {
  const safeParams = sanitizeParamsForUserMessage(params);
  const count = hotels?.length || 0;

  if (options.isPagination) {
    if (Number(safeParams.filter_rating_min) > 0) {
      return composeRatingFilterResultMessage(safeParams, count, {
        isPagination: true,
        ratingFallback: options.ratingFallback,
        hotels,
      });
    }
    return composeResultsCountMessage(safeParams, count, { isPagination: true, hotels });
  }

  if (!count) {
    return composeNoResultsAdvice(safeParams, options);
  }

  return composeResultsIntro(safeParams, hotels, options);
}

module.exports = {
  stripMetaLanguage,
  composeResultsIntro,
  composeNoResultsAdvice,
  composeLimitedCatalogAdvice,
  composeResultsText,
  formatHotelLine,
  isLimitedPackageDestination,
};
