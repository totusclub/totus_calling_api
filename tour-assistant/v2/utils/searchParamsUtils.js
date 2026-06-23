function mergeSearchParamsFromHistory(conversationHistory) {
  const merged = {
    from_city: '',
    from_country: 'RU',
    to_country: '',
    to_city: '',
    adults: '1',
    kids: '0',
    kids_ages: [],
    start_date: '',
    nights: 1,
    search_type: 'package',
    flex_dates: 2,
    hotel_ids: [],
    page_number: 1,
    page_limit: 3,
    sort_by: 'relevance',
  };

  for (const msg of conversationHistory || []) {
    if (msg.searchParams && typeof msg.searchParams === 'object') {
      Object.assign(merged, msg.searchParams);
    }
  }

  return merged;
}

module.exports = { mergeSearchParamsFromHistory };
