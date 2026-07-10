const {
  ConversationStage,
  isReady,
  applyDefaults,
  prepareSearchParams,
  getNextMissingField,
  resolveStage,
  userWantsMoreHotelsAfterResults,
  userWantsRetrySearch,
  userAsksWhyNoResults,
  userAsksSearchAlternatives,
  userAsksDestinationActivities,
  userAsksHotelComparison,
  isPostSearchAdvisoryText,
  getLastShownHotels,
  getAllShownHotelIds,
  searchFiltersChanged,
  buildSearchFingerprint,
  summarizeKnownParams,
} = require('./conversation.state');
const { formatDestinationPoPhrase, formatDestinationSummary, formatDestinationInPhrase, syncDestinationLabels } = require('./destination.labels');
const { composeLimitedCatalogAdvice, isLimitedPackageDestination } = require('./response.composer');
const { extractDestinationQuery, extractExplicitCityName, resolveDestinationByText } = require('./destination.resolver');
const { applyExtraction, mergeSearchParams } = require('./params.extractor');
const { extractParamsWithAi } = require('./ai.param-extractor');
const { resolveHotelByName, extractHotelNameFromText, normalizeHotelNameCandidate } = require('./hotel.resolver');
const { executeSearch } = require('./search.engine');
const { createTextMessage, createAssistantMessage } = require('./dto/messages');
const { generateCollectionQuestion } = require('./question.composer');
const { generateDestinationActivitiesAnswer } = require('./destination.info.composer');
const { generatePostSearchReply, generateHotelComparisonReply } = require('./post.search.composer');
const memory = require('./memory.store');
const manager = require('./conversation.manager');
const { classifyIntent } = require('./intent.router');
const {
  ensureMeta,
  recordTurn,
  recordAssistantReply,
  shouldForceEscalation,
  appendEpisodicEvent,
  isConversationTooLong,
} = require('./conversation.health');
const { applyEscalationStep, resetEscalation } = require('./escalation.engine');
const {
  savePreferencesFromPatch,
  applySemanticDefaults,
  clearDestinationParams,
  sanitizeFromCity,
} = require('./memory.episodic');
const { verifyBeforeSend } = require('./verifier');

function ensureConversationState(conversation) {
  if (!conversation.stage) conversation.stage = ConversationStage.COLLECTING_PARAMS;
  if (!conversation.results) conversation.results = { hotels: [] };
  ensureMeta(conversation);
}

function resetSearchSession(conversation) {
  conversation.searchSession = {
    requestId: null,
    readyOperators: [],
    currentPage: 0,
  };
  conversation.shownHotelIds = [];
  conversation.lastSearchFingerprint = null;
  conversation.searchParams = mergeSearchParams(conversation.searchParams || {}, { page_number: 1 });
}

/**
 * Runs the search + auto-escalation chain SILENTLY and pushes exactly one
 * final assistant message. Intermediate replies are never stored, so the
 * client can never see an answer that later changes or disappears.
 */
async function searchWithAutoEscalation(conversation, onChunk) {
  let result = await executeSearch(conversation, { isPagination: false, silent: true });
  let lastNote = '';

  // Limited-catalog destinations (France, Germany, Italy…): escalation only
  // repeats the same empty search 4 more times (~minutes of frontend timeout).
  // Reply immediately with honest catalog advice instead.
  if (
    getLastShownHotels(conversation).length === 0 &&
    !conversation.searchFailed &&
    isLimitedPackageDestination(conversation.searchParams)
  ) {
    const reply = composeLimitedCatalogAdvice(conversation.searchParams);
    const msg = createTextMessage({ role: 'assistant', content: reply });
    conversation.messages.push(msg);
    recordAssistantReply(conversation, reply);
    memory.saveConversation(conversation);
    const payload = buildApiPayload(conversation);
    if (onChunk) onChunk({ event: 'final_message', data: payload });
    return payload;
  }

  while (
    getLastShownHotels(conversation).length === 0 &&
    !conversation.searchFailed &&
    (conversation.meta?.escalation_level || 0) < 4
  ) {
    const params = conversation.searchParams || {};
    const { patch, level, preface, exhausted } = applyEscalationStep(conversation, params);

    if (exhausted) {
      const reply = isLimitedPackageDestination(params)
        ? composeLimitedCatalogAdvice(params)
        : `По ${formatDestinationSummary(params) || 'этом направлении'} исчерпал стандартные варианты поиска. ` +
          'Рекомендую начать новый чат (кнопка «+») и указать направление, даты и бюджет заново — ' +
          'или попробуйте поиск на totus.club с теми же параметрами.';
      const msg = createTextMessage({ role: 'assistant', content: reply });
      conversation.messages.push(msg);
      recordAssistantReply(conversation, reply);
      conversation.meta.suggested_reset = true;
      memory.saveConversation(conversation);
      const payload = buildApiPayload(conversation);
      if (onChunk) onChunk({ event: 'final_message', data: payload });
      return payload;
    }

    conversation.searchParams = mergeSearchParams(params, patch);
    conversation.searchParams = syncDestinationLabels(conversation.searchParams);
    resetSearchSession(conversation);
    conversation.stage = ConversationStage.READY_TO_SEARCH;
    appendEpisodicEvent(conversation, { type: 'escalation', level, patch });

    result = await executeSearch(conversation, {
      isPagination: false,
      escalationNote: preface,
      silent: true,
    });
    lastNote = preface;
  }

  const hotels = conversation.results?.hotels || [];
  let content = result?.content || '';
  if (lastNote && !content.startsWith(lastNote) && !content.includes(lastNote)) {
    content = `${lastNote}\n\n${content}`;
  }
  const finalMsg = createAssistantMessage({ content, hotels });
  conversation.messages.push(finalMsg);
  recordAssistantReply(conversation, content);

  memory.saveConversation(conversation);
  const payload = buildApiPayload(conversation);
  if (onChunk) onChunk({ event: 'final_message', data: payload });
  return payload;
}

function pushAssistantReply(conversation, content, onChunk) {
  const msg = createTextMessage({ role: 'assistant', content });
  conversation.messages.push(msg);
  recordAssistantReply(conversation, content);
  memory.saveConversation(conversation);
  const payload = buildApiPayload(conversation);
  if (onChunk) onChunk({ event: 'final_message', data: payload });
  return payload;
}

async function handleComplaint(conversation, userText, params, onChunk) {
  const summary = summarizeKnownParams(params).join('; ') || 'параметры не полностью собраны';
  const reply =
    `Понимаю — извините за повторяющиеся ответы. Сейчас в сессии: ${summary}. ` +
    'Могу сразу повторить поиск с другими параметрами — напишите куда хотите поехать и бюджет, ' +
    'или начните новый чат (кнопка «+»), чтобы сбросить старые данные.';
  conversation.meta.identical_reply_streak = 0;
  conversation.meta.suggested_reset = true;
  appendEpisodicEvent(conversation, { type: 'complaint', userText: userText.slice(0, 120) });
  return pushAssistantReply(conversation, reply, onChunk);
}

async function handleSessionReset(conversation, onChunk) {
  const kept = {
    from_city: conversation.searchParams?.from_city || 'Moscow',
    from_country: conversation.searchParams?.from_country || 'RU',
    adults: conversation.searchParams?.adults || '',
  };
  conversation.searchParams = mergeSearchParams(clearDestinationParams({}), kept);
  resetSearchSession(conversation);
  resetEscalation(conversation);
  conversation.meta.identical_reply_streak = 0;
  conversation.meta.last_reply_hash = '';
  conversation.stage = ConversationStage.COLLECTING_PARAMS;
  appendEpisodicEvent(conversation, { type: 'soft_reset' });
  const reply =
    'Начинаем с чистого листа. Куда планируете поехать — страна, город или конкретный отель?';
  return pushAssistantReply(conversation, reply, onChunk);
}

async function handleTravelAdvice(conversation, userText, params, onChunk) {
  const dest = formatDestinationSummary(params);
  const reply = dest
    ? `По вопросу «${userText.slice(0, 80)}»: для ${dest} уточню детали при бронировании. ` +
      'Если нужны туры с ценами — напишите даты и бюджет, и я подберу варианты из каталога Totus.'
    : `Хороший вопрос. Чтобы дать точный ответ по визе, погоде или сезону, сначала укажите направление — ` +
      'куда планируете поехать?';
  return pushAssistantReply(conversation, reply, onChunk);
}

const NON_DESTINATION_COLLECTION_FIELDS = new Set([
  'from_city',
  'start_date',
  'nights',
  'adults',
  'kids',
  'kids_ages',
  'filter_price_max',
  'filter_meals',
  'search_intent',
]);

async function enrichDestinationFromApi(
  conversation,
  userText,
  nextFieldBefore,
  paramsBefore = {},
) {
  const params = conversation.searchParams || {};
  if (params.hotel_ids?.length || params.search_intent === 'hotel') return;

  if (NON_DESTINATION_COLLECTION_FIELDS.has(nextFieldBefore)) {
    const explicitDest =
      extractDestinationQuery(userText) || extractExplicitCityName(userText);
    if (!explicitDest) {
      if (params.to_country) {
        conversation.searchParams = syncDestinationLabels(params);
      }
      return;
    }
  }

  const query =
    nextFieldBefore === 'destination'
      ? String(userText || '').trim()
      : extractDestinationQuery(userText) ||
        extractExplicitCityName(userText) ||
        (params.to_city && params.to_country ? params.to_city : '');

  if (!query || query.length < 2) {
    if (params.to_country) {
      conversation.searchParams = syncDestinationLabels(params);
    }
    return;
  }

  const destinationChanged =
    params.to_country !== paramsBefore.to_country ||
    params.to_city !== paramsBefore.to_city;

  const needsResolve =
    nextFieldBefore === 'destination' ||
    !params.to_country ||
    destinationChanged ||
    !params.destination_label;

  if (!needsResolve) {
    conversation.searchParams = syncDestinationLabels(params);
    return;
  }

  if (params.to_country && !destinationChanged) {
    conversation.searchParams = syncDestinationLabels(params);
    return;
  }

  const resolved = await resolveDestinationByText(query, params.from_city || 'Moscow');
  if (!resolved) {
    if (params.to_country) {
      conversation.searchParams = syncDestinationLabels(params);
    }
    return;
  }

  const { kind, ...patch } = resolved;
  conversation.searchParams = syncDestinationLabels(mergeSearchParams(params, patch));
  if (kind === 'country') {
    if (!conversation.meta) conversation.meta = {};
    conversation.meta.user_requested_to_city = false;
    delete conversation.searchParams.to_city;
    conversation.searchParams = syncDestinationLabels(conversation.searchParams);
  }
}

function buildApiPayload(conversation) {
  return {
    conversationId: conversation.id,
    state: conversation.stage,
    messages: conversation.messages,
    results: conversation.results || { hotels: [] },
    searchParams: conversation.searchParams || {},
    searchSession: conversation.searchSession || {
      requestId: null,
      readyOperators: [],
      currentPage: 0,
    },
    collectionStep: getNextMissingField(conversation.searchParams) || 'complete',
  };
}

async function resolveHotelNames(conversation, userText = '') {
  const params = conversation.searchParams || {};
  if (params.filter_rating_min) {
    const cleared = mergeSearchParams(params, {
      hotel_name: '',
      hotel_ids: [],
      search_intent: 'package',
      search_type: 'package',
    });
    conversation.searchParams = cleared;
    return cleared;
  }

  const freshExtract = userText ? extractHotelNameFromText(userText) : null;
  if (freshExtract) {
    const freshNorm = normalizeHotelNameCandidate(freshExtract).toLowerCase();
    const currentNorm = normalizeHotelNameCandidate(params.hotel_name || '').toLowerCase();
    if (!currentNorm || freshNorm !== currentNorm) {
      params.hotel_name = freshExtract;
      params.hotel_ids = [];
      if (conversation.meta) delete conversation.meta.resolved_hotel_query;
      conversation.searchParams = params;
    }
  }

  if (!params.hotel_name) return params;

  const queryKey = String(params.hotel_name).trim().toLowerCase();
  if (params.hotel_ids?.length) {
    if (conversation.meta?.resolved_hotel_query === queryKey) {
      return params;
    }
    conversation.searchParams = mergeSearchParams(params, { hotel_ids: [] });
  }

  const resolved = await resolveHotelByName(params.hotel_name, params.from_city || 'Moscow', {
    to_country: params.to_country,
    to_city: params.to_city,
  });
  if (!resolved) {
    conversation.hotelResolveAttempts = (conversation.hotelResolveAttempts || 0) + 1;
    if (conversation.hotelResolveAttempts >= 2) {
      conversation.searchParams = mergeSearchParams(params, {
        hotel_name: '',
        search_intent: 'package',
        search_type: 'package',
      });
    }
    return conversation.searchParams;
  }

  conversation.hotelResolveAttempts = 0;
  conversation.meta = conversation.meta || {};
  conversation.meta.resolved_hotel_query = queryKey;

  const wantsPackage =
    params.search_intent === 'package' || params.search_type === 'package';
  conversation.searchParams = mergeSearchParams(params, {
    hotel_ids: [resolved.hotel_id],
    hotel_name: resolved.hotel_name,
    search_type: wantsPackage ? 'package' : 'hotel',
    search_intent: wantsPackage ? 'package' : 'hotel',
    to_country: resolved.to_country || params.to_country,
    to_city: resolved.to_city || params.to_city,
    destination_label: resolved.destination_label || params.destination_label,
    destination_label_prep: resolved.destination_label_prep || params.destination_label_prep,
  });
  conversation.meta.city_from_hotel = true;
  if (resolved.to_city) {
    conversation.meta.user_requested_to_city = true;
  }
  return conversation.searchParams;
}

function buildPostSearchReply(conversation, userText, params) {
  const summary = summarizeKnownParams(params);
  const known = summary.length ? summary.join(', ') : 'ваши параметры';
  const hadResults = getLastShownHotels(conversation).length > 0;

  if (userAsksWhyNoResults(userText)) {
    if (conversation.searchFailed) {
      return `Поиск завершился с ошибкой при обработке результатов. Параметры сохранены: ${known}. Напишите «найди снова» — повторю поиск, или укажите другие даты.`;
    }
    if (!hadResults) {
      if (isLimitedPackageDestination(params)) {
        return composeLimitedCatalogAdvice(params);
      }
      return `По ${formatDestinationPoPhrase(params)} на ${params.start_date || 'выбранные даты'} (${params.nights || '?'} ночей) сейчас нет доступных туров. Могу сдвинуть даты на неделю или предложить соседний курорт — что предпочитаете?`;
    }
    return `Результаты уже показаны выше. Могу найти другие варианты — напишите «ещё» или уточните даты.`;
  }

  if (params.adults && /^(я\s+)?(один|одна|одного)$/i.test((userText || '').trim())) {
    return `Записал: ${params.adults} ${Number(params.adults) === 1 ? 'взрослый' : 'взрослых'}. ${hadResults ? 'Результаты уже выше.' : 'Поиск не дал результатов — попробуйте другие даты или напишите «найди снова».'}`;
  }

  return `${hadResults ? 'Результаты уже показаны.' : 'По этим параметрам вариантов пока нет.'} Могу изменить даты, количество ночей или направление — что уточним?`;
}

async function handleDestinationActivitiesQuestion(
  conversation,
  userText,
  params,
  justReceived,
  onChunk,
) {
  const infoAnswer = await generateDestinationActivitiesAnswer(
    userText,
    conversation,
    params,
  );

  const nextField = getNextMissingField(params);
  let tail = '';

  if (nextField) {
    const followUp = await generateCollectionQuestion(
      userText,
      conversation,
      nextField,
      params,
      justReceived,
    );
    tail = followUp ? `\n\n${followUp}` : '';
  } else if (conversation.lastSearchFingerprint) {
    tail =
      '\n\nЕсли захотите — подберу другие варианты или скорректирую параметры поездки.';
  } else {
    tail =
      '\n\nПараметры поездки уже собраны — напишите «найди», и я подберу лучшие предложения.';
  }

  const msg = createTextMessage({
    role: 'assistant',
    content: `${infoAnswer}${tail}`,
  });
  conversation.messages.push(msg);
  recordAssistantReply(conversation, `${infoAnswer}${tail}`);
  conversation.stage = resolveStage(params, conversation.stage);
  memory.saveConversation(conversation);

  const payload = buildApiPayload(conversation);
  if (onChunk) onChunk({ event: 'final_message', data: payload });
  return payload;
}

/**
 * Step-by-step concierge: collect one field per turn → auto-search when complete.
 */
async function processTurn(conversationId, userText, { userId, onChunk } = {}) {
  const conversation = memory.getConversation(conversationId);
  if (!conversation) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }
  if (userId && conversation.userId && String(conversation.userId) !== String(userId)) {
    const err = new Error('Forbidden');
    err.status = 403;
    throw err;
  }

  ensureConversationState(conversation);
  manager.appendUserMessage(conversation, userText);
  memory.saveConversation(conversation);

  try {
    return await processTurnBody(conversation, userText, { userId, onChunk });
  } catch (err) {
    console.error('[V2 tour.orchestrator] processTurn failed:', err);
    const msg = createTextMessage({
      role: 'assistant',
      content:
        'Извините, не удалось обработать сообщение. Попробуйте отправить ещё раз или уточните запрос.',
    });
    conversation.messages.push(msg);
    memory.saveConversation(conversation);
    const payload = buildApiPayload(conversation);
    if (onChunk) onChunk({ event: 'final_message', data: payload });
    return payload;
  }
}

async function processTurnBody(conversation, userText, { onChunk } = {}) {
  if (onChunk) onChunk({ event: 'typing', data: { active: true } });

  const nextFieldBefore = getNextMissingField(conversation.searchParams);
  const paramsBefore = { ...(conversation.searchParams || {}) };
  const shownHotelsBefore = getLastShownHotels(conversation);
  const isAdvisoryTurn =
    shownHotelsBefore.length > 0 && isPostSearchAdvisoryText(userText);

  if (!isAdvisoryTurn) {
    applyExtraction(conversation, userText, null, nextFieldBefore);
    const aiParams = await extractParamsWithAi(userText, conversation, nextFieldBefore);
    applyExtraction(conversation, userText, { searchParams: aiParams }, nextFieldBefore);
    await enrichDestinationFromApi(conversation, userText, nextFieldBefore, paramsBefore);
  } else {
    applyExtraction(conversation, userText, null, nextFieldBefore);
  }

  const justReceived = {};
  const paramsAfter = conversation.searchParams || {};
  for (const key of Object.keys(paramsAfter)) {
    const prev = paramsBefore[key];
    const next = paramsAfter[key];
    if (JSON.stringify(prev) !== JSON.stringify(next) && next !== '' && next != null) {
      justReceived[key] = next;
    }
  }

  // User picked a new date themselves — it becomes the new anchor,
  // any previously stored escalation date must not overwrite it.
  if (justReceived.start_date && conversation.meta?.original_start_date) {
    delete conversation.meta.original_start_date;
  }

  if (justReceived.to_country || justReceived.to_city) {
    const destChanged =
      justReceived.to_country !== paramsBefore.to_country ||
      justReceived.to_city !== paramsBefore.to_city;
    if (destChanged) {
      resetEscalation(conversation);
      resetSearchSession(conversation);
    }
  }

  if (isAdvisoryTurn) {
    conversation.searchParams = mergeSearchParams(paramsAfter, {
      from_city: paramsBefore.from_city,
      to_city: paramsBefore.to_city,
      to_country: paramsBefore.to_country,
      destination_label: paramsBefore.destination_label,
      destination_label_prep: paramsBefore.destination_label_prep,
      start_date: paramsBefore.start_date,
      nights: paramsBefore.nights,
      adults: paramsBefore.adults,
      kids: paramsBefore.kids,
      kids_ages: paramsBefore.kids_ages,
      search_intent: paramsBefore.search_intent || 'package',
      search_type: paramsBefore.search_type || 'package',
      hotel_ids: paramsBefore.hotel_ids || [],
      hotel_name: paramsBefore.hotel_name || '',
    });
  }

  await resolveHotelNames(conversation, userText);
  conversation.searchParams = applyDefaults(conversation.searchParams);
  conversation.searchParams = sanitizeFromCity(conversation.searchParams, userText);
  conversation.searchParams = applySemanticDefaults(conversation.searchParams, conversation);
  savePreferencesFromPatch(conversation, justReceived);

  const params = conversation.searchParams;

  recordTurn(conversation);
  const shownCount = getLastShownHotels(conversation).length;
  const intent = classifyIntent(userText, conversation, { justReceived, params });
  appendEpisodicEvent(conversation, {
    type: 'turn',
    intent: intent.primary,
    confidence: intent.confidence,
  });

  if (isConversationTooLong(conversation) && !conversation.meta.suggested_reset) {
    conversation.meta.suggested_reset = true;
    const longReply =
      'Диалог стал длинным — параметры могли запутаться. ' +
      'Для точного поиска рекомендую новый чат (кнопка «+») или напишите «с нуля».';
    return pushAssistantReply(conversation, longReply, onChunk);
  }

  if (intent.primary === 'COMPLAINT') {
    return handleComplaint(conversation, userText, params, onChunk);
  }

  if (intent.primary === 'RESET_SESSION') {
    return handleSessionReset(conversation, onChunk);
  }

  if (intent.primary === 'TRAVEL_ADVICE') {
    return handleTravelAdvice(conversation, userText, params, onChunk);
  }

  if (intent.primary === 'NO_RESULTS_ALTERNATIVES') {
    const reply = isLimitedPackageDestination(params)
      ? composeLimitedCatalogAdvice(params)
      : `По ${formatDestinationPoPhrase(params)} туров в каталоге сейчас нет. ` +
        'Могу рассказать о направлении, подобрать другую страну с готовыми турами или поискать только отель — что выберете?';
    return pushAssistantReply(conversation, reply, onChunk);
  }

  if (
    intent.primary === 'WHY_NO_RESULTS' &&
    conversation.meta?.last_search_outcome === 'no_results'
  ) {
    const reply = buildPostSearchReply(conversation, userText, params);
    return pushAssistantReply(conversation, reply, onChunk);
  }

  if (intent.rejectCurrent) {
    conversation.searchParams = clearDestinationParams(params);
    conversation.searchParams = sanitizeFromCity(
      mergeSearchParams(conversation.searchParams, {
        from_city: params.from_city || 'Moscow',
        from_country: params.from_country || 'RU',
        adults: params.adults,
        start_date: params.start_date,
        nights: params.nights,
      }),
      userText,
    );
    resetSearchSession(conversation);
    resetEscalation(conversation);
    await enrichDestinationFromApi(conversation, userText, 'destination', {});
    appendEpisodicEvent(conversation, { type: 'reject_destination' });
  }

  const forceEscalation = shouldForceEscalation(conversation);
  const forcesSearch =
    intent.forcesSearch || forceEscalation;

  if (isAdvisoryTurn) {
    const shownHotels = getLastShownHotels(conversation);
    const reply = userAsksHotelComparison(userText)
      ? await generateHotelComparisonReply(userText, conversation, params, shownHotels)
      : await generatePostSearchReply(userText, conversation, params);
    const msg = createTextMessage({ role: 'assistant', content: reply });
    conversation.messages.push(msg);
    recordAssistantReply(conversation, reply);
    conversation.stage = ConversationStage.RESULTS;
    memory.saveConversation(conversation);
    const payload = buildApiPayload(conversation);
    if (onChunk) onChunk({ event: 'final_message', data: payload });
    return payload;
  }

  if (userAsksDestinationActivities(userText)) {
    return handleDestinationActivitiesQuestion(
      conversation,
      userText,
      params,
      justReceived,
      onChunk,
    );
  }

  const session = conversation.searchSession || {};
  const wantsMore = userWantsMoreHotelsAfterResults(userText);
  if (
    wantsMore &&
    (conversation.stage === ConversationStage.RESULTS || conversation.lastSearchFingerprint)
  ) {
    if (session.requestId) {
      const excludeHotelIds = getAllShownHotelIds(conversation);
      const nextPage = (session.currentPage || params.page_number || 1) + 1;
      conversation.searchParams = mergeSearchParams(params, { page_number: nextPage });
      await executeSearch(conversation, { isPagination: true, excludeHotelIds });
    } else {
      const excludeHotelIds = getAllShownHotelIds(conversation);
      conversation.searchParams = mergeSearchParams(params, { page_number: 1 });
      resetSearchSession(conversation);
      await executeSearch(conversation, { isPagination: false, excludeHotelIds });
    }
    memory.saveConversation(conversation);
    const payload = buildApiPayload(conversation);
    if (onChunk) onChunk({ event: 'final_message', data: payload });
    return payload;
  }

  // «рейтинг не важен» / «без рейтинга» — drop the rating filter and re-search
  const wantsClearRating =
    /рейтинг\w*\s*(не\s*важ|неваж|любой|не\s*нужен|убер)|без\s*рейтинг|неважно\s*рейтинг/i.test(
      userText || '',
    ) && Boolean(params.filter_rating_min);
  if (wantsClearRating) {
    delete conversation.searchParams.filter_rating_min;
    if (conversation.searchParams.sort_by === 'rating,desc') {
      conversation.searchParams.sort_by = 'price,asc';
    }
  }

  if (isReady(params)) {
    const fingerprint = buildSearchFingerprint(params);
    const alreadySearched = conversation.lastSearchFingerprint === fingerprint;
    const wantsRetry = userWantsRetrySearch(userText);
    const filtersChanged = searchFiltersChanged(justReceived) || wantsClearRating;
    const retryAfterNoResults =
      userAsksWhyNoResults(userText) &&
      (conversation.searchFailed || shownCount === 0) &&
      conversation.meta?.last_search_outcome !== 'no_results';
    const inResultsStage =
      conversation.stage === ConversationStage.RESULTS ||
      conversation.searchFailed ||
      conversation.lastSearchFingerprint;

    const useTemplateReply =
      alreadySearched &&
      inResultsStage &&
      !wantsRetry &&
      !filtersChanged &&
      !wantsMore &&
      !retryAfterNoResults &&
      !forcesSearch &&
      intent.allowsTemplateReply !== false;

    if (useTemplateReply) {
      let reply = userAsksWhyNoResults(userText)
        ? buildPostSearchReply(conversation, userText, params)
        : await generatePostSearchReply(userText, conversation, params);

      const verification = verifyBeforeSend(conversation, reply, { intent });
      if (!verification.ok && verification.shouldEscalate) {
        return searchWithAutoEscalation(conversation, onChunk);
      }

      return pushAssistantReply(conversation, reply, onChunk);
    }

    if (filtersChanged || retryAfterNoResults || forcesSearch) {
      conversation.searchParams = mergeSearchParams(params, { page_number: 1 });
      conversation.searchSession = {
        requestId: null,
        readyOperators: [],
        currentPage: 0,
      };
      conversation.shownHotelIds = [];
      if (justReceived.to_country || justReceived.to_city) {
        resetEscalation(conversation);
        if (!justReceived.filter_price_max) {
          delete conversation.searchParams.filter_price_max;
        }
        if (!justReceived.filter_meals) {
          delete conversation.searchParams.filter_meals;
        }
        if (!justReceived.filter_rating_min) {
          delete conversation.searchParams.filter_rating_min;
        }
        delete conversation.searchParams.filter_line;
        delete conversation.searchParams.filter_beach_surface;
        delete conversation.searchParams.filter_sandy_beach;
        conversation.searchParams = syncDestinationLabels(conversation.searchParams);
      }
      if (justReceived.filter_stars) {
        conversation.searchParams.filter_stars = justReceived.filter_stars;
      }
      if (justReceived.filter_rating_min) {
        conversation.searchParams.filter_rating_min = justReceived.filter_rating_min;
        conversation.searchParams.sort_by = 'rating,desc';
      }
    }

    conversation.stage = ConversationStage.READY_TO_SEARCH;
    memory.saveConversation(conversation);

    if (forceEscalation && (conversation.meta?.escalation_level || 0) > 0) {
      return searchWithAutoEscalation(conversation, onChunk);
    }

    return searchWithAutoEscalation(conversation, onChunk);
  }

  conversation.stage = resolveStage(params, conversation.stage);
  const nextField = getNextMissingField(params);

  const assistantContent = await generateCollectionQuestion(
    userText,
    conversation,
    nextField,
    params,
    justReceived,
  );

  const fallback = assistantContent || 'Расскажите, куда планируете поехать?';
  return pushAssistantReply(conversation, fallback, onChunk);
}

module.exports = {
  processTurn,
  buildApiPayload,
  ensureConversationState,
};
