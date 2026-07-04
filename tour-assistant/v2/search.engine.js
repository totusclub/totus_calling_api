const { ConversationStage, buildSearchFingerprint, prepareSearchParams } = require('./conversation.state');
const { syncDestinationLabels } = require('./destination.labels');
const hotelSearch = require('./hotel.search.service');
const { createAssistantMessage } = require('./dto/messages');
const { composeResultsText, isLimitedPackageDestination } = require('./response.composer');
const memory = require('./memory.store');
const {
  recordSearchOutcome,
  appendEpisodicEvent,
} = require('./conversation.health');
const { resetEscalation } = require('./escalation.engine');

async function executeSearch(
  conversation,
  { isPagination = false, excludeHotelIds = [], escalationNote = '', silent = false } = {},
) {
  conversation.searchParams = syncDestinationLabels(prepareSearchParams(conversation.searchParams));
  conversation.stage = ConversationStage.SEARCHING;
  memory.saveConversation(conversation);

  try {
    const {
      hotels,
      triedRelaxed,
      budgetExceeded,
      ratingMinExceeded,
      ratingFallback,
      hotelOverBudget,
      actualMinPrice,
    } = await hotelSearch.runHotelSearch(
      conversation,
      conversation.searchParams,
      { isPagination, excludeHotelIds },
    );

    const isHotelSearch =
      !conversation.searchParams?.filter_rating_min &&
      (conversation.searchParams?.search_type === 'hotel' ||
        (conversation.searchParams?.hotel_ids?.length > 0));

    let content = composeResultsText(conversation.searchParams, hotels, {
      isPagination,
      isHotelSearch,
      triedRelaxed,
      budgetExceeded: budgetExceeded && !hotelOverBudget,
      ratingMinExceeded,
      ratingFallback,
      hotelOverBudget,
      actualMinPrice,
      catalogLimited:
        !(hotels || []).length && isLimitedPackageDestination(conversation.searchParams),
    });

    const originalDate = conversation.meta?.original_start_date;
    const shiftedDate = conversation.searchParams?.start_date;
    if ((hotels || []).length && originalDate && shiftedDate && originalDate !== shiftedDate) {
      const { formatDateRu } = require('./destination.labels');
      const origRu = formatDateRu(originalDate);
      const shiftRu = formatDateRu(shiftedDate);
      if (origRu && shiftRu) {
        content = `На ${origRu} туров не было — показываю варианты с вылетом ${shiftRu}. Если хотите именно ${origRu}, напишите — поищу ещё раз ближе к вашей дате.\n\n${content}`;
      }
    } else if (escalationNote && (hotels || []).length) {
      content = `${escalationNote}\n\n${content}`;
    }

    // silent: caller composes and pushes the single final message itself
    // (prevents intermediate replies that later get replaced in the UI)
    if (!silent) {
      const resultsMsg = createAssistantMessage({
        content,
        hotels: hotels || [],
      });
      conversation.messages.push(resultsMsg);
    }

    conversation.results = { hotels: hotels || [] };
    conversation.stage = ConversationStage.RESULTS;
    conversation.searchFailed = false;
    conversation.lastSearchFingerprint = buildSearchFingerprint(conversation.searchParams);

    const outcome =
      (hotels || []).length > 0
        ? 'found'
        : budgetExceeded || hotelOverBudget
          ? 'budget_exceeded'
          : 'no_results';
    recordSearchOutcome(conversation, outcome);
    if ((hotels || []).length > 0) {
      resetEscalation(conversation);
    }
    appendEpisodicEvent(conversation, {
      type: 'search',
      outcome,
      fingerprint: conversation.lastSearchFingerprint,
      hotelCount: (hotels || []).length,
      escalationNote: escalationNote || null,
    });

    if (conversation.searchParams?.page_number) {
      conversation.searchSession = conversation.searchSession || {};
      conversation.searchSession.currentPage = conversation.searchParams.page_number;
    }

    return { hotels: hotels || [], error: null, content };
  } catch (err) {
    console.error('[V2 search.engine] Search failed:', err);
    const errContent =
      'Не удалось подобрать варианты. Попробуйте уточнить даты или направление — подберу альтернативу.';
    if (!silent) {
      const errMsg = createAssistantMessage({
        content: errContent,
        hotels: [],
      });
      conversation.messages.push(errMsg);
    }
    conversation.results = { hotels: [] };
    conversation.stage = ConversationStage.RESULTS;
    conversation.searchFailed = true;
    conversation.lastSearchFingerprint = buildSearchFingerprint(conversation.searchParams);
    recordSearchOutcome(conversation, 'error');
    appendEpisodicEvent(conversation, {
      type: 'search',
      outcome: 'error',
      message: err.message,
    });
    return { hotels: [], error: err, content: errContent };
  } finally {
    memory.saveConversation(conversation);
  }
}

module.exports = { executeSearch };
