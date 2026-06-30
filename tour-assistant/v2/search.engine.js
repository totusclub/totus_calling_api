const { ConversationStage, buildSearchFingerprint, prepareSearchParams } = require('./conversation.state');
const { syncDestinationLabels } = require('./destination.labels');
const hotelSearch = require('./hotel.search.service');
const { createAssistantMessage } = require('./dto/messages');
const { composeResultsText } = require('./response.composer');
const memory = require('./memory.store');

async function executeSearch(conversation, { isPagination = false, excludeHotelIds = [] } = {}) {
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

    const content = composeResultsText(conversation.searchParams, hotels, {
      isPagination,
      isHotelSearch,
      triedRelaxed,
      budgetExceeded: budgetExceeded && !hotelOverBudget,
      ratingMinExceeded,
      ratingFallback,
      hotelOverBudget,
      actualMinPrice,
    });

    const resultsMsg = createAssistantMessage({
      content,
      hotels: hotels || [],
    });
    conversation.messages.push(resultsMsg);

    conversation.results = { hotels: hotels || [] };
    conversation.stage = ConversationStage.RESULTS;
    conversation.searchFailed = false;
    conversation.lastSearchFingerprint = buildSearchFingerprint(conversation.searchParams);

    if (conversation.searchParams?.page_number) {
      conversation.searchSession = conversation.searchSession || {};
      conversation.searchSession.currentPage = conversation.searchParams.page_number;
    }

    return { hotels: hotels || [], error: null };
  } catch (err) {
    console.error('[V2 search.engine] Search failed:', err);
    const errMsg = createAssistantMessage({
      content:
        'Не удалось подобрать варианты. Попробуйте уточнить даты или направление — подберу альтернативу.',
      hotels: [],
    });
    conversation.messages.push(errMsg);
    conversation.results = { hotels: [] };
    conversation.stage = ConversationStage.RESULTS;
    conversation.searchFailed = true;
    conversation.lastSearchFingerprint = buildSearchFingerprint(conversation.searchParams);
    return { hotels: [], error: err };
  } finally {
    memory.saveConversation(conversation);
  }
}

module.exports = { executeSearch };
