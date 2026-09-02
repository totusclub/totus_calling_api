const axios = require('axios');
const { DEEPSEEK_API_KEY, DEEPSEEK_API_URL } = require('./config');
const { DEEPSEEK_MODEL, LLM_TEMPERATURE } = require('../llm.config');
const DEEPSEEK_SYSTEM_PROMPT_MESSAGE = require('./systemPrompt');
const { mergeSearchParamsFromHistory } = require('./searchParamsUtils');
async function callDeepSeek(userMessage, conversationHistory, currentSearchParams = {}) {
    // [PAGINATION_DEBUG] Entry
    console.log('[PAGINATION_DEBUG] -------- callDeepSeek ENTRY --------');
    console.log('[PAGINATION_DEBUG] currentSearchParams.page_number:', currentSearchParams.page_number);
    console.log('[PAGINATION_DEBUG] userMessage:', (userMessage || '').substring(0, 60));

    // AI will determine pagination based on context and user message
    // We only check if there's an active search to provide context to AI
    const hasActiveSearch = currentSearchParams && currentSearchParams.to_country && currentSearchParams.start_date;
    console.log('[PAGINATION_DEBUG] hasActiveSearch:', hasActiveSearch, 'to_country:', currentSearchParams.to_country, 'start_date:', currentSearchParams.start_date);
    
    // Build messages array with proper role structure
    const messages = [
        { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT_MESSAGE },
    ];

    // Add conversation history with proper role structure
    for (const msg of conversationHistory) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            messages.push({
                role: msg.role,
                content: msg.content || msg.text || '',
            });
        }
    }

    // Include current search params context so the AI knows the current page_number
    // This is critical for pagination: AI needs to know current state to make correct decisions
    if (currentSearchParams && currentSearchParams.page_number && currentSearchParams.to_country) {
        const currentPageNumber = currentSearchParams.page_number || 1;
        const nextPageNumber = currentPageNumber + 1;
        
        messages.push({
            role: 'system',
            content: `🔍 КОНТЕКСТ АКТИВНОГО ПОИСКА:
Текущие параметры поиска: ${JSON.stringify(currentSearchParams)}
Текущий page_number = ${currentPageNumber}
Следующий page_number должен быть = ${nextPageNumber}

ТВОЯ ЗАДАЧА - ОПРЕДЕЛИТЬ ПАГИНАЦИЮ:
1. Если пользователь просит "ещё", "другие", "покажи ещё", "следующие", "дальше", "ищи", "ещо", "еще" и т.п.
   И при этом НЕ меняет основные параметры (страну, дату, ночи, людей, бюджет) → это ПАГИНАЦИЯ
   
2. При пагинации:
   - Верни ПОЛНЫЙ объект searchParams со ВСЕМИ теми же параметрами из текущего поиска
   - Установи page_number = ${nextPageNumber} (ОБЯЗАТЕЛЬНО ${nextPageNumber}, не ${currentPageNumber}!)
   - Включи ВСЕ параметры: to_country, start_date, nights, adults, kids, kids_ages, filter_price_max, filter_price_min, from_city, from_country, to_city, все фильтры
   - nextQuestion: "Ищу ещё варианты для тебя! 🔎"
   - НЕ меняй никакие другие параметры при пагинации, только page_number!

3. Если пользователь ИЗМЕНЯЕТ параметры (страну, дату, ночи, людей, бюджет) → это НОВЫЙ поиск с page_number = 1

КРИТИЧЕСКИ ВАЖНО: 
- Если это пагинация - верни page_number = ${nextPageNumber} (текущий ${currentPageNumber} + 1)
- Если новый поиск - верни page_number = 1
- При пагинации ВСЕГДА возвращай ПОЛНЫЙ объект searchParams со ВСЕМИ параметрами из текущего поиска`,
        });
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    try {
        const response = await axios.post(
            DEEPSEEK_API_URL,
            {
                model: DEEPSEEK_MODEL,
                messages,
                temperature: LLM_TEMPERATURE.chat,
                max_tokens: 600,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                },
                timeout: 30000,
            }
        );

        // DeepSeek can return plain text or JSON
        const aiText = response.data?.choices?.[0]?.message?.content;
        if (!aiText) {
            return { 
                chatMode: true,
                nextQuestion: 'Извините, не удалось получить ответ. Попробуйте еще раз.', 
                searchParams: {} 
            };
        }

        // Try parsing JSON if AI returned object
        let parsed = {};
        try {
            // Clean the response - remove markdown code blocks if present
            let cleanText = aiText.trim();
            if (cleanText.startsWith('```json')) {
                cleanText = cleanText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            } else if (cleanText.startsWith('```')) {
                cleanText = cleanText.replace(/```\n?/g, '').trim();
            }
            // Try to extract JSON from mixed content (text + JSON)
            if (!cleanText.startsWith('{')) {
                const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    cleanText = jsonMatch[0];
                }
            }
            parsed = JSON.parse(cleanText);
        } catch (e) {
            // If it's not JSON, treat as chat response
            // But first clean any JSON-like content from the text
            console.log('[DeepSeek] Response is not JSON, treating as chat:', aiText.substring(0, 100));
            let cleanResponse = aiText.trim();
            // Remove any JSON blocks that might be in the response
            cleanResponse = cleanResponse.replace(/```json[\s\S]*?```/g, '').trim();
            cleanResponse = cleanResponse.replace(/\{[\s\S]*"chatMode"[\s\S]*\}/g, '').trim();
            cleanResponse = cleanResponse.replace(/\{[\s\S]*"searchParams"[\s\S]*\}/g, '').trim();
            if (!cleanResponse) {
                cleanResponse = 'Чем могу помочь?';
            }
            return { 
                chatMode: true,
                nextQuestion: cleanResponse, 
                searchParams: currentSearchParams 
            };
        }

        // Extract chatMode (default to false if not specified, but check if it's a chat response)
        const chatMode = parsed.chatMode !== undefined ? parsed.chatMode : false;

        // Validate nextQuestion is not raw JSON
        let nextQuestion = parsed.nextQuestion || '';
        if (typeof nextQuestion === 'object') {
            nextQuestion = '';
        }
        // If nextQuestion looks like JSON, clean it
        if (nextQuestion && (nextQuestion.includes('"chatMode"') || nextQuestion.includes('"searchParams"'))) {
            nextQuestion = nextQuestion.replace(/\{[\s\S]*"chatMode"[\s\S]*\}/g, '').trim();
            nextQuestion = nextQuestion.replace(/\{[\s\S]*"searchParams"[\s\S]*\}/g, '').trim();
            if (!nextQuestion) {
                nextQuestion = chatMode ? 'Чем ещё могу помочь?' : '';
            }
        }

        // --- BACKEND-SIDE PAGINATION SAFETY ---
        // User wants "more" results → if есть активный поиск, но AI не увеличил page_number,
        // форсим корректный page_number здесь, чтобы логика пагинации работала на 100%.
        if (!chatMode && hasActiveSearch) {
            const normalizedUserText = (userMessage || '').toLowerCase();
            const userWantsMore =
                normalizedUserText.includes('ещё') ||
                normalizedUserText.includes('еще') ||
                normalizedUserText.includes('ещо') ||
                normalizedUserText.includes('другие') ||
                normalizedUserText.includes('следующие') ||
                normalizedUserText.includes('дальше') ||
                normalizedUserText.includes('покажи ещё') ||
                normalizedUserText.includes('покажи еще') ||
                normalizedUserText.includes('найди ещё') ||
                normalizedUserText.includes('найди еще') ||
                normalizedUserText.includes('ищи') ||
                normalizedUserText.includes('поищи') ||
                normalizedUserText.includes('найти друга варианты') ||
                normalizedUserText.includes('найти другие варианты');

            if (userWantsMore) {
                const currentPageNumber = currentSearchParams.page_number || 1;
                console.log('[PAGINATION_DEBUG] userWantsMore=true, currentPageNumber:', currentPageNumber);
                if (!parsed.searchParams || typeof parsed.searchParams !== 'object') {
                    parsed.searchParams = {};
                }
                
                // КРИТИЧЕСКИ ВАЖНО: При пагинации копируем ВСЕ параметры из currentSearchParams в parsed.searchParams
                // Это гарантирует, что AI получит полный контекст и вернет правильный JSON
                Object.keys(currentSearchParams).forEach(key => {
                    if (key !== 'page_number' && parsed.searchParams[key] === undefined) {
                        parsed.searchParams[key] = currentSearchParams[key];
                    }
                });
                
                // Если AI не задал page_number или вернул <= текущей страницы – поднимаем страницу на +1
                const aiPageNumber = parsed.searchParams.page_number || 1;
                // CRITICAL: Always increment page_number for pagination requests
                // Use the maximum of (currentPageNumber + 1) and aiPageNumber to ensure we always advance
                const forcedPageNumber = Math.max(currentPageNumber + 1, aiPageNumber);
                parsed.searchParams.page_number = forcedPageNumber;
                
                console.log('[PAGINATION_DEBUG] BACKEND FORCED PAGINATION: currentPageNumber:', currentPageNumber, '→ forcedPageNumber:', forcedPageNumber, 'AI had returned:', aiPageNumber);
                
                if (aiPageNumber <= currentPageNumber) {
                    console.log('[Backend] ✅ FORCED pagination - user wants more, currentPage:', currentPageNumber, '→ forced page_number:', forcedPageNumber, 'AI returned:', aiPageNumber);
                } else if (aiPageNumber === forcedPageNumber) {
                    console.log('[Backend] ✅ Pagination confirmed - currentPage:', currentPageNumber, '→ page_number:', forcedPageNumber, 'AI returned:', aiPageNumber);
                } else {
                    console.log('[Backend] ✅ Pagination adjusted - currentPage:', currentPageNumber, '→ page_number:', forcedPageNumber, 'AI returned:', aiPageNumber);
                }
                console.log('[Backend] Copied all params from currentSearchParams to parsed.searchParams for pagination');
            } else {
                console.log('[PAGINATION_DEBUG] userWantsMore=false (no pagination keywords in message)');
            }
        } else {
            console.log('[PAGINATION_DEBUG] Skipped pagination safety: chatMode=', chatMode, 'hasActiveSearch=', hasActiveSearch);
        }

        // Merge with current searchParams (only if not in chat mode)
        // For pagination: preserve ALL existing params and only update page_number
        // For new search: merge AI's params with current params
        const mergedParams = chatMode ? {} : { ...currentSearchParams };
        
        if (!chatMode && parsed.searchParams && typeof parsed.searchParams === 'object') {
            // AI-BASED PAGINATION: Trust AI's decision completely
            // If AI returns page_number > 1 AND core params match → it's pagination
            const aiPageNumber = parsed.searchParams.page_number || 1;
            const currentPageNumber = currentSearchParams.page_number || 1;
            
            // Check if core params match (for pagination detection)
            // If parsed.searchParams doesn't have these fields, they should match (we copied them above)
            const paramsMatch = currentSearchParams.to_country && 
                               (parsed.searchParams.to_country === currentSearchParams.to_country || !parsed.searchParams.to_country || parsed.searchParams.to_country === '') &&
                               (parsed.searchParams.start_date === currentSearchParams.start_date || !parsed.searchParams.start_date || parsed.searchParams.start_date === '');
            
            // CRITICAL: Check if user wants pagination (keywords were detected above)
            // This is the PRIMARY way to detect pagination - more reliable than AI's page_number
            const userWantsMore = (userMessage || '').toLowerCase().includes('другие') ||
                                 (userMessage || '').toLowerCase().includes('ещё') ||
                                 (userMessage || '').toLowerCase().includes('еще') ||
                                 (userMessage || '').toLowerCase().includes('ещо') ||
                                 (userMessage || '').toLowerCase().includes('ищи') ||
                                 (userMessage || '').toLowerCase().includes('поищи') ||
                                 (userMessage || '').toLowerCase().includes('найди') ||
                                 (userMessage || '').toLowerCase().includes('предлагай') ||
                                 (userMessage || '').toLowerCase().includes('следующие') ||
                                 (userMessage || '').toLowerCase().includes('дальше');
            
            // Pagination if:
            // 1. We have active search AND
            // 2. Core params match (or user wants more) AND
            // 3. (AI says page_number > 1 OR backend forced increment OR user wants more)
            const isPagination = hasActiveSearch && 
                                paramsMatch && 
                                (aiPageNumber > 1 || aiPageNumber > currentPageNumber || userWantsMore);
            
            console.log('[Backend] Pagination check:', {
                hasActiveSearch,
                aiPageNumber,
                currentPageNumber,
                paramsMatch,
                isPagination,
                userWantsMore,
                to_country_current: currentSearchParams.to_country,
                to_country_parsed: parsed.searchParams.to_country,
                start_date_current: currentSearchParams.start_date,
                start_date_parsed: parsed.searchParams.start_date,
                to_country_match: parsed.searchParams.to_country === currentSearchParams.to_country || !parsed.searchParams.to_country || parsed.searchParams.to_country === '',
                start_date_match: parsed.searchParams.start_date === currentSearchParams.start_date || !parsed.searchParams.start_date || parsed.searchParams.start_date === '',
            });
            console.log('[PAGINATION_DEBUG] isPagination=', isPagination, '→ mergedParams.page_number will be:', isPagination ? parsed.searchParams.page_number : '(from merge)');
            
            if (isPagination) {
                // For pagination: preserve ALL current params, use AI's page_number
                console.log('[Backend] ✅ PAGINATION CONFIRMED - page_number:', aiPageNumber, 'preserving all params');
                
                // CRITICAL: Start with ALL currentSearchParams, then override only page_number and page_limit
                // IMPORTANT: mergedParams already has currentSearchParams from line 2237, but we need to ensure ALL fields are preserved
                Object.assign(mergedParams, currentSearchParams);
                // CRITICAL: Use the forced page_number from parsed.searchParams (which was already incremented above)
                mergedParams.page_number = parsed.searchParams.page_number; // This is the forced/incremented value
                mergedParams.page_limit = 3; // ALWAYS force page_limit to 3 for pagination
                
                console.log('[Backend] Merged params for pagination:', {
                    page_number: mergedParams.page_number,
                    to_country: mergedParams.to_country,
                    start_date: mergedParams.start_date,
                    nights: mergedParams.nights,
                    adults: mergedParams.adults,
                    filter_price_max: mergedParams.filter_price_max,
                });
                
                // Merge any new filter params that AI might have returned (but don't override existing ones)
                const filterFields = ['filter_price_min', 'filter_price_max', 'filter_stars', 'filter_meals', 
                    'filter_instant_confirm', 'filter_regions', 'filter_line', 'filter_operators', 'filter_hotel_type', 'filter_beach_surface'];
                for (const field of filterFields) {
                    if (parsed.searchParams[field] !== undefined && parsed.searchParams[field] !== null && parsed.searchParams[field] !== '') {
                        mergedParams[field] = parsed.searchParams[field];
                    }
                }
            } else {
                // For new search or field updates: merge AI's params
                Object.assign(mergedParams, parsed.searchParams);
            }
        } else if (!chatMode && (nextQuestion === null || nextQuestion === '' || !nextQuestion)) {
            // If no nextQuestion and not chat mode, merge root-level search fields only
            const searchFields = ['from_city', 'from_country', 'to_country', 'to_city', 'adults', 'kids', 'kids_ages', 'start_date', 'nights', 'search_type', 'flex_dates', 'hotel_ids', 'page_number', 'page_limit', 'sort_by'];
            for (const field of searchFields) {
                if (parsed[field] !== undefined) {
                    mergedParams[field] = parsed[field];
                }
            }
        }

        // Ensure required fields have defaults (only if not in chat mode)
        // For pagination: preserve existing values, don't override
        if (!chatMode) {
            const isPagination = mergedParams.page_number > 1 && currentSearchParams.to_country;
            
            if (!mergedParams.from_country) mergedParams.from_country = currentSearchParams.from_country || 'RU';
            if (!mergedParams.adults) mergedParams.adults = isPagination ? (currentSearchParams.adults || '1') : '1';
            if (!mergedParams.kids) mergedParams.kids = isPagination ? (currentSearchParams.kids || '0') : '0';
            if (!mergedParams.kids_ages) mergedParams.kids_ages = isPagination ? (currentSearchParams.kids_ages || []) : [];
            if (!mergedParams.search_type) mergedParams.search_type = 'package';
            if (!mergedParams.flex_dates) mergedParams.flex_dates = isPagination ? (currentSearchParams.flex_dates || 2) : 2;
            if (!mergedParams.hotel_ids) mergedParams.hotel_ids = [];
            if (!mergedParams.page_number) mergedParams.page_number = 1;
            // ALWAYS force page_limit to 3 - CRITICAL for consistent pagination
            mergedParams.page_limit = 3;
            if (!mergedParams.sort_by) mergedParams.sort_by = 'relevance';
            
            // For pagination: preserve all filter params from current search
            if (isPagination) {
                console.log('[Backend] Preserving all params for pagination...');
                const filterFields = ['filter_price_min', 'filter_price_max', 'filter_stars', 'filter_meals', 
                    'filter_instant_confirm', 'filter_regions', 'filter_line', 'filter_operators', 'filter_hotel_type', 'filter_beach_surface'];
                for (const field of filterFields) {
                    if (currentSearchParams[field] !== undefined && mergedParams[field] === undefined) {
                        mergedParams[field] = currentSearchParams[field];
                    }
                }
                // Preserve core search params - CRITICAL for pagination
                if (!mergedParams.to_country && currentSearchParams.to_country) {
                    mergedParams.to_country = currentSearchParams.to_country;
                    console.log('[Backend] Preserved to_country:', currentSearchParams.to_country);
                }
                if (!mergedParams.start_date && currentSearchParams.start_date) {
                    mergedParams.start_date = currentSearchParams.start_date;
                    console.log('[Backend] Preserved start_date:', currentSearchParams.start_date);
                }
                if (!mergedParams.nights && currentSearchParams.nights) {
                    mergedParams.nights = currentSearchParams.nights;
                    console.log('[Backend] Preserved nights:', currentSearchParams.nights);
                }
                if (!mergedParams.adults && currentSearchParams.adults) {
                    mergedParams.adults = currentSearchParams.adults;
                    console.log('[Backend] Preserved adults:', currentSearchParams.adults);
                }
                if (!mergedParams.kids && currentSearchParams.kids !== undefined) {
                    mergedParams.kids = currentSearchParams.kids;
                    console.log('[Backend] Preserved kids:', currentSearchParams.kids);
                }
                if (!mergedParams.kids_ages && currentSearchParams.kids_ages) {
                    mergedParams.kids_ages = currentSearchParams.kids_ages;
                    console.log('[Backend] Preserved kids_ages:', currentSearchParams.kids_ages);
                }
                if (!mergedParams.filter_price_max && currentSearchParams.filter_price_max) {
                    mergedParams.filter_price_max = currentSearchParams.filter_price_max;
                    console.log('[Backend] Preserved filter_price_max:', currentSearchParams.filter_price_max);
                }
                if (!mergedParams.from_city && currentSearchParams.from_city) {
                    mergedParams.from_city = currentSearchParams.from_city;
                    console.log('[Backend] Preserved from_city:', currentSearchParams.from_city);
                }
                if (!mergedParams.from_country && currentSearchParams.from_country) {
                    mergedParams.from_country = currentSearchParams.from_country;
                    console.log('[Backend] Preserved from_country:', currentSearchParams.from_country);
                }
            }
        }

        // Final logging before return
        const finalPageNumber = mergedParams.page_number || 1;
        console.log('[Backend] ✅ Final response:', {
            chatMode,
            nextQuestion: nextQuestion ? nextQuestion.substring(0, 50) : '',
            page_number: finalPageNumber,
            to_country: mergedParams.to_country,
            start_date: mergedParams.start_date,
            nights: mergedParams.nights,
            adults: mergedParams.adults,
            filter_price_max: mergedParams.filter_price_max,
            hasActiveSearch,
            paramsCount: Object.keys(mergedParams).length,
        });

        return { 
            chatMode: chatMode,
            nextQuestion: nextQuestion, 
            searchParams: chatMode ? {} : mergedParams 
        };

    } catch (error) {
        console.error('Error calling DeepSeek:', error);
        return { 
            chatMode: true,
            nextQuestion: 'Извините, произошла ошибка при обработке запроса. Попробуйте еще раз.', 
            searchParams: {} 
        };
    }
}

module.exports = { callDeepSeek, mergeSearchParamsFromHistory };
