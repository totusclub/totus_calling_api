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
  userAsksDestinationActivities,
  userAsksHotelComparison,
  isPostSearchAdvisoryText,
  getLastShownHotels,
  getAllShownHotelIds,
  searchFiltersChanged,
  buildSearchFingerprint,
  summarizeKnownParams,
} = require('./conversation.state');
const { formatDestinationPoPhrase, formatDestinationSummary, formatDestinationInPhrase } = require('./destination.labels');
const { extractDestinationQuery, extractExplicitCityName, resolveDestinationByText } = require('./destination.resolver');
const { applyExtraction, mergeSearchParams } = require('./params.extractor');
const { extractParamsWithAi } = require('./ai.param-extractor');
const { resolveHotelByName } = require('./hotel.resolver');
const { executeSearch } = require('./search.engine');
const { createTextMessage } = require('./dto/messages');
const { generateCollectionQuestion } = require('./question.composer');
const { generateDestinationActivitiesAnswer } = require('./destination.info.composer');
const { generatePostSearchReply, generateHotelComparisonReply } = require('./post.search.composer');
const memory = require('./memory.store');
const manager = require('./conversation.manager');

function ensureConversationState(conversation) {
  if (!conversation.stage) conversation.stage = ConversationStage.COLLECTING_PARAMS;
  if (!conversation.results) conversation.results = { hotels: [] };
}

async function enrichDestinationFromApi(
  conversation,
  userText,
  nextFieldBefore,
  paramsBefore = {},
) {
  const params = conversation.searchParams || {};
  if (params.hotel_ids?.length || params.search_intent === 'hotel') return;

  const query =
    nextFieldBefore === 'destination'
      ? String(userText || '').trim()
      : extractDestinationQuery(userText) || extractExplicitCityName(userText);

  if (!query || query.length < 2) return;

  const destinationChanged =
    params.to_country !== paramsBefore.to_country ||
    params.to_city !== paramsBefore.to_city;

  const needsResolve =
    nextFieldBefore === 'destination' ||
    !params.to_country ||
    destinationChanged ||
    !params.destination_label;

  if (!needsResolve) return;

  if (params.to_country && !destinationChanged) {
    conversation.searchParams = mergeSearchParams(params, {
      destination_label: formatDestinationSummary(params),
      destination_label_prep: formatDestinationInPhrase(params),
    });
    return;
  }

  const resolved = await resolveDestinationByText(query, params.from_city || 'Moscow');
  if (!resolved) return;

  const { kind, ...patch } = resolved;
  conversation.searchParams = mergeSearchParams(params, patch);
  if (kind === 'country') {
    delete conversation.searchParams.to_city;
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

async function resolveHotelNames(conversation) {
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
  if (!params.hotel_name || params.hotel_ids?.length) return params;
  if (params.search_intent === 'package' || params.search_type === 'package') {
    const cleared = { ...params };
    delete cleared.hotel_name;
    conversation.searchParams = cleared;
    return cleared;
  }

  const resolved = await resolveHotelByName(params.hotel_name, params.from_city || 'Moscow');
  if (!resolved) {
    conversation.hotelResolveAttempts = (conversation.hotelResolveAttempts || 0) + 1;
    if (conversation.hotelResolveAttempts >= 2) {
      conversation.searchParams = mergeSearchParams(params, {
        hotel_name: '',
        search_intent: 'package',
        search_type: 'package',
        to_city: params.to_city || params.hotel_name,
      });
    }
    return conversation.searchParams;
  }

  conversation.hotelResolveAttempts = 0;

  conversation.searchParams = mergeSearchParams(params, {
    hotel_ids: [resolved.hotel_id],
    hotel_name: resolved.hotel_name,
    search_type: 'hotel',
    to_country: params.to_country || resolved.to_country,
    to_city: params.to_city || resolved.to_city,
  });
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

  await resolveHotelNames(conversation);
  conversation.searchParams = applyDefaults(conversation.searchParams);

  const params = conversation.searchParams;

  if (isAdvisoryTurn) {
    const shownHotels = getLastShownHotels(conversation);
    const reply = userAsksHotelComparison(userText)
      ? await generateHotelComparisonReply(userText, conversation, params, shownHotels)
      : await generatePostSearchReply(userText, conversation, params);
    const msg = createTextMessage({ role: 'assistant', content: reply });
    conversation.messages.push(msg);
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
    session.requestId &&
    (conversation.stage === ConversationStage.RESULTS || conversation.lastSearchFingerprint)
  ) {
    const excludeHotelIds = getAllShownHotelIds(conversation);
    const nextPage = (session.currentPage || params.page_number || 1) + 1;
    conversation.searchParams = mergeSearchParams(params, { page_number: nextPage });
    await executeSearch(conversation, { isPagination: true, excludeHotelIds });
    memory.saveConversation(conversation);
    const payload = buildApiPayload(conversation);
    if (onChunk) onChunk({ event: 'final_message', data: payload });
    return payload;
  }

  if (isReady(params)) {
    const fingerprint = buildSearchFingerprint(params);
    const alreadySearched = conversation.lastSearchFingerprint === fingerprint;
    const wantsRetry = userWantsRetrySearch(userText);
    const filtersChanged = searchFiltersChanged(justReceived);
    const inResultsStage =
      conversation.stage === ConversationStage.RESULTS ||
      conversation.searchFailed ||
      conversation.lastSearchFingerprint;

    if (alreadySearched && inResultsStage && !wantsRetry && !filtersChanged && !wantsMore) {
      const reply = userAsksWhyNoResults(userText)
        ? buildPostSearchReply(conversation, userText, params)
        : await generatePostSearchReply(userText, conversation, params);
      const msg = createTextMessage({ role: 'assistant', content: reply });
      conversation.messages.push(msg);
      conversation.stage = ConversationStage.RESULTS;
      memory.saveConversation(conversation);
      const payload = buildApiPayload(conversation);
      if (onChunk) onChunk({ event: 'final_message', data: payload });
      return payload;
    }

    if (filtersChanged) {
      conversation.searchParams = mergeSearchParams(params, { page_number: 1 });
      conversation.searchSession = {
        requestId: null,
        readyOperators: [],
        currentPage: 0,
      };
      conversation.shownHotelIds = [];
      if (justReceived.to_country || justReceived.to_city) {
        if (!justReceived.filter_price_max) {
          delete conversation.searchParams.filter_price_max;
        }
        conversation.searchParams.destination_label = '';
        conversation.searchParams.destination_label_prep = '';
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
    conversation.searchParams = prepareSearchParams(conversation.searchParams);
    memory.saveConversation(conversation);
    await executeSearch(conversation, { isPagination: false });
    const payload = buildApiPayload(conversation);
    if (onChunk) onChunk({ event: 'final_message', data: payload });
    return payload;
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

  const msg = createTextMessage({
    role: 'assistant',
    content: assistantContent || 'Расскажите, куда планируете поехать?',
  });
  conversation.messages.push(msg);
  memory.saveConversation(conversation);

  const payload = buildApiPayload(conversation);
  if (onChunk) onChunk({ event: 'final_message', data: payload });
  return payload;
}

module.exports = {
  processTurn,
  buildApiPayload,
  ensureConversationState,
};
