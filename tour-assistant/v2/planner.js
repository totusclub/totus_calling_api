/**
 * Lightweight action planner — decides WHAT to do, not how to phrase it.
 */
function buildActionPlan(intent, conversation, context = {}) {
  const { params = {}, shownCount = 0 } = context;
  const actions = [];

  switch (intent.primary) {
    case 'COMPLAINT':
      actions.push({ type: 'REPAIR_CONVERSATION' });
      break;

    case 'RESET_SESSION':
      actions.push({ type: 'SOFT_RESET' });
      actions.push({ type: 'ASK_DESTINATION' });
      break;

    case 'DESTINATION_QA':
      actions.push({ type: 'ANSWER_DESTINATION_INFO' });
      break;

    case 'TRAVEL_ADVICE':
      actions.push({ type: 'ANSWER_TRAVEL_ADVICE' });
      break;

    case 'COMPARE_HOTELS':
      actions.push({ type: 'COMPARE_SHOWN_HOTELS' });
      break;

    case 'MORE_RESULTS':
      actions.push({ type: 'PAGINATE_SEARCH' });
      break;

    case 'RETRY_SEARCH':
    case 'REFINE_SEARCH':
    case 'CHANGE_DESTINATION':
    case 'WHY_NO_RESULTS':
      if (intent.rejectCurrent) actions.push({ type: 'CLEAR_DESTINATION' });
      actions.push({ type: 'RESET_SEARCH_SESSION' });
      actions.push({ type: 'RUN_SEARCH' });
      break;

    case 'SEARCH_HOTEL':
      actions.push({ type: 'RUN_SEARCH' });
      break;

    case 'POST_SEARCH_CHAT':
      if (context.forceEscalation) {
        actions.push({ type: 'ESCALATE_SEARCH' });
      } else {
        actions.push({ type: 'TEMPLATE_REPLY' });
      }
      break;

    default:
      if (shownCount === 0 && params.to_country && context.isReady) {
        actions.push({ type: 'RUN_SEARCH' });
      } else {
        actions.push({ type: 'COLLECT_FIELD' });
      }
      break;
  }

  return actions;
}

module.exports = { buildActionPlan };
