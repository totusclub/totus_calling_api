function applyAutoSearchFix({ text, aiResponse, conversationHistory, mergedParams, currentSearchParams }) {
        const searchKeywords = ['ищу', 'подбираю', 'поиск', 'ищем', 'ищю', 'найд'];
        const nextQuestionLower = (aiResponse.nextQuestion || '').toLowerCase();
        const aiSaysSearching = searchKeywords.some(kw => nextQuestionLower.includes(kw));
        
        // Check if user message contains filter keywords (stars, meals, beach, line)
        const textLower = text.toLowerCase();
        
        // CHECK IF USER IS SATISFIED/DONE - should NOT trigger search
        const userIsSatisfied = textLower.match(/спасибо|благодар|отлично|супер|класс|нашёл|нашел|нашла|выбрал|выбрала|понрав|нравится|хорош|подход|устраива|беру|бронир|заказ|оформ|thank|thanks|perfect|great|found|like|good/);
        const userSaysGoodbye = textLower.match(/пока|до свидан|прощай|bye|goodbye|see you/);
        const userAskingQuestion = textLower.match(/^(что|как|какой|какая|какие|где|когда|почему|зачем|сколько|можно|есть|а |расскажи|покажи|опиши)\s/);
        
        // If user is satisfied or saying goodbye, skip auto-search entirely
        if (userIsSatisfied || userSaysGoodbye) {
            console.log('✅ USER IS SATISFIED/DONE - skipping auto-search');
            console.log('   userIsSatisfied:', !!userIsSatisfied);
            console.log('   userSaysGoodbye:', !!userSaysGoodbye);
        }
        const userAddingFilter = textLower.match(/звезд|зв[её]зд|звод|ультра|у[ль]тра|включ|вклуч|песок|песч|песоч|галька|галеч|галка|платформ|понтон|перв.*лин|втор.*лин|трет.*лин|первая|вторая|третья|линия|у\s*моря|beachfront|завтр|зафтр|полупансион|пансион/);
        
        // Check if user is changing required parameters (date, nights, adults, budget)
        const userChangingParams = textLower.match(/(\d+)\s*(ноч|ночей|дней|день|марта|февраля|января|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|взросл|человек|чел|руб|рубл|\d{5,})/);
        
        // Extract parameter changes from user message
        let paramChanges = {};
        if (userChangingParams) {
            // Nights detection
            const nightsMatch = textLower.match(/(\d+)\s*(ноч|ночей|дней)/);
            if (nightsMatch) {
                paramChanges.nights = nightsMatch[1];
                console.log('🔄 PARAM CHANGE: nights =', paramChanges.nights);
            }
            
            // Adults detection
            const adultsMatch = textLower.match(/(\d+)\s*(взросл|человек|чел)/);
            if (adultsMatch) {
                paramChanges.adults = adultsMatch[1];
                console.log('🔄 PARAM CHANGE: adults =', paramChanges.adults);
            }
            
            // Budget detection
            const budgetMatch = textLower.match(/(\d{5,})\s*(руб|рубл)?/);
            if (budgetMatch) {
                paramChanges.filter_price_max = budgetMatch[1];
                console.log('🔄 PARAM CHANGE: filter_price_max =', paramChanges.filter_price_max);
            }
            
            // Date detection (simple pattern for now)
            const dateMatch = textLower.match(/(\d{1,2})\s*(марта|февраля|января|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/);
            if (dateMatch) {
                const day = dateMatch[1].padStart(2, '0');
                const monthMap = {
                    'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
                    'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
                    'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12'
                };
                const month = monthMap[dateMatch[2]];
                const year = new Date().getFullYear();
                const currentMonth = new Date().getMonth() + 1;
                const targetMonth = parseInt(month);
                const targetYear = targetMonth < currentMonth ? year + 1 : year;
                paramChanges.start_date = `${targetYear}-${month}-${day}`;
                console.log('🔄 PARAM CHANGE: start_date =', paramChanges.start_date);
            }
        }
        
        // Use both mergedParams and currentSearchParams to check for required fields
        const combinedParams = { ...mergedParams, ...currentSearchParams };
        
        // Check if we have core required fields (price is optional, can default to high value)
        const hasCoreFields = combinedParams.to_country && 
                              combinedParams.start_date && 
                              combinedParams.nights && 
                              combinedParams.adults;
        
        // Also check if previous search was done (hotels in conversation means we had a successful search)
        const hadPreviousSearch = conversationHistory.some(msg => 
            msg.hotels && Array.isArray(msg.hotels) && msg.hotels.length > 0
        );
        
        // Check if we had a previous successful search based on currentSearchParams having complete data
        const hadSearchFromParams = currentSearchParams.to_country && 
                                    currentSearchParams.start_date && 
                                    currentSearchParams.nights;
        
        // Check if AI returned incomplete/empty searchParams
        const aiSearchParams = aiResponse.searchParams || {};
        const aiParamsKeys = Object.keys(aiSearchParams).filter(k => aiSearchParams[k] !== '' && aiSearchParams[k] !== undefined && aiSearchParams[k] !== null);
        const aiHasIncompleteParams = aiParamsKeys.length < 5 || !aiSearchParams.to_country || !aiSearchParams.start_date;
        
        console.log('🔍 AUTO-SEARCH CHECK:', {
            aiSaysSearching,
            userAddingFilter: !!userAddingFilter,
            userChangingParams: !!userChangingParams,
            paramChanges: Object.keys(paramChanges).length > 0 ? paramChanges : 'none',
            hasCoreFields,
            hadPreviousSearch,
            hadSearchFromParams,
            aiHasIncompleteParams,
            aiParamsKeysCount: aiParamsKeys.length,
            combinedParamsKeys: Object.keys(combinedParams).filter(k => combinedParams[k]).length,
            to_country: combinedParams.to_country,
            start_date: combinedParams.start_date,
            nights: combinedParams.nights,
            adults: combinedParams.adults,
            filter_price_max: combinedParams.filter_price_max,
            aiChatMode: aiResponse.chatMode,
            aiNextQuestion: (aiResponse.nextQuestion || '').substring(0, 80),
            aiSearchParamsKeys: Object.keys(aiSearchParams).join(','),
        });
        
        let finalSearchParams = aiResponse.searchParams;
        let finalChatMode = aiResponse.chatMode;
        
        // If AI says "Ищу..." but didn't return proper searchParams, use combinedParams
        // Trigger if: 
        //   (AI says searching OR user adding filter OR user changing params) 
        //   AND (we have core fields OR had previous search OR had search from params) 
        //   AND AI returned incomplete params
        //   AND user is NOT satisfied/done with the search
        const canAutoSearch = hasCoreFields || hadPreviousSearch || hadSearchFromParams;
        const userMakingChanges = userAddingFilter || userChangingParams;
        const userNotDone = !userIsSatisfied && !userSaysGoodbye;
        const shouldAutoSearch = (aiSaysSearching || userMakingChanges) && canAutoSearch && aiHasIncompleteParams && userNotDone;
        
        // NEW FIX: If AI says "Ищу..." but returned chatMode: true, override to false
        // This handles the case where AI returns complete searchParams but still says chatMode: true
        // But NOT if user is satisfied/done
        const shouldForceChatModeFalse = (aiSaysSearching || userMakingChanges) && canAutoSearch && aiResponse.chatMode === true && userNotDone;
        
        console.log('🔍 shouldAutoSearch:', shouldAutoSearch, '(aiSaysSearching:', aiSaysSearching, ', userMakingChanges:', !!userMakingChanges, ', canAutoSearch:', canAutoSearch, ', aiHasIncompleteParams:', aiHasIncompleteParams, ', userNotDone:', userNotDone, ')');
        console.log('🔍 shouldForceChatModeFalse:', shouldForceChatModeFalse);
        
        if (shouldAutoSearch) {
            console.log('🔧 AUTO-SEARCH FIX: AI said "Ищу" but returned incomplete params. Using combinedParams.');
            console.log('🔧 Trigger reason: aiSaysSearching=' + aiSaysSearching + ', hasCoreFields=' + hasCoreFields + ', hadPreviousSearch=' + hadPreviousSearch);
            
            // Start with combinedParams (has all required fields from history)
            finalSearchParams = { ...combinedParams };
            
            // Copy any filters from AI response (in case AI extracted them from user message)
            const filterKeys = ['filter_stars', 'filter_meals', 'filter_line', 'filter_beach_surface', 
                               'filter_price_min', 'filter_price_max', 'filter_instant_confirm'];
            filterKeys.forEach(key => {
                if (aiSearchParams[key] !== undefined && aiSearchParams[key] !== '') {
                    finalSearchParams[key] = aiSearchParams[key];
                }
            });
            
            // Apply user's parameter changes (nights, adults, budget, date)
            if (Object.keys(paramChanges).length > 0) {
                Object.assign(finalSearchParams, paramChanges);
                console.log('🔧 AUTO-SEARCH FIX: Applied param changes:', paramChanges);
            }
            
            // Extract filters from user message (backup if AI didn't extract them)
            const userTextLower = text.toLowerCase();
            
            // Stars detection - more patterns, handle typos like "зводни" instead of "звезды"
            if (!finalSearchParams.filter_stars) {
                if (userTextLower.match(/толко\s*5|только\s*5|5\s*зв|5\s*звод|пять\s*зв/)) {
                    finalSearchParams.filter_stars = '5';
                } else if (userTextLower.match(/толко\s*4|только\s*4|4\s*зв|4\s*звод|четыре\s*зв/)) {
                    finalSearchParams.filter_stars = '4';
                } else if (userTextLower.match(/4-5|4\s*и\s*5/)) {
                    finalSearchParams.filter_stars = '4,5';
                } else if (userTextLower.match(/толко\s*3|только\s*3|3\s*зв|3\s*звод|три\s*зв/)) {
                    finalSearchParams.filter_stars = '3';
                }
            }
            
            // Also extract stars from AI's nextQuestion
            if (!finalSearchParams.filter_stars) {
                const nextQLower = (aiResponse.nextQuestion || '').toLowerCase();
                if (nextQLower.match(/5.*звёзд|5.*звезд|5-звёзд/)) {
                    finalSearchParams.filter_stars = '5';
                } else if (nextQLower.match(/4.*звёзд|4.*звезд|4-звёзд/)) {
                    finalSearchParams.filter_stars = '4';
                } else if (nextQLower.match(/3.*звёзд|3.*звезд|3-звёзд/)) {
                    finalSearchParams.filter_stars = '3';
                }
            }
            
            // Meals detection - ALWAYS check user message for meal changes (not just when empty)
            // Priority: check if user wants to CHANGE meals first
            const userWantsBreakfast = userTextLower.match(/толко\s*завтр|только\s*завтр|завтрак|завтрик|зафтр/);
            const userWantsHalfBoard = userTextLower.match(/полупансион|завтрак.*ужин|ужин.*завтрак/);
            const userWantsFullBoard = userTextLower.match(/полный\s*пансион|трёхразов|трехразов/);
            const userWantsAI = userTextLower.match(/(все|всё).*(включ|вклуч)/) && !userTextLower.match(/у[ль]?тра/);
            const userWantsUAI = userTextLower.match(/у[ль]?тра.*(включ|вклуч)/);
            const userDoesntWantUAI = userTextLower.match(/не\s*хочу.*(у[ль]?тра|все.*включ|всё.*включ)/);
            
            // Apply meal changes based on user request
            if (userWantsBreakfast || userDoesntWantUAI) {
                finalSearchParams.filter_meals = 'BB';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = BB (breakfast only)');
            } else if (userWantsHalfBoard) {
                finalSearchParams.filter_meals = 'HB';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = HB (half board)');
            } else if (userWantsFullBoard) {
                finalSearchParams.filter_meals = 'FB';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = FB (full board)');
            } else if (userWantsUAI) {
                finalSearchParams.filter_meals = 'UAI';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = UAI (ultra all inclusive)');
            } else if (userWantsAI) {
                finalSearchParams.filter_meals = 'AI';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_meals = AI (all inclusive)');
            }
            
            // Also check AI's nextQuestion for meal type (only if user didn't specify)
            if (!userWantsBreakfast && !userWantsHalfBoard && !userWantsFullBoard && !userWantsAI && !userWantsUAI && !userDoesntWantUAI) {
                const nextQLower = (aiResponse.nextQuestion || '').toLowerCase();
                if (nextQLower.match(/завтрак|breakfast/i) && !nextQLower.match(/включ/)) {
                    finalSearchParams.filter_meals = 'BB';
                } else if (nextQLower.match(/ультра.*(включ|вклуч)|ultra.*all.*incl/i)) {
                    finalSearchParams.filter_meals = 'UAI';
                } else if (nextQLower.match(/(все|всё).*(включ|вклуч)|all.*incl/i)) {
                    finalSearchParams.filter_meals = 'AI';
                }
            }
            
            // Line detection - ALWAYS check for line changes (not just when empty)
            const userWantsFirstLine = userTextLower.match(/перв.*лин|1.*лин|первая\s*лин|первой\s*лин|на\s*первой|у\s*моря|beachfront/);
            const userWantsSecondLine = userTextLower.match(/втор.*лин|2.*лин|вторая\s*лин|второй\s*лин|на\s*второй/);
            const userWantsThirdLine = userTextLower.match(/трет.*лин|3.*лин|третья\s*лин|третьей\s*лин|на\s*третьей/);
            
            if (userWantsFirstLine) {
                finalSearchParams.filter_line = '1';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_line = 1 (first line)');
            } else if (userWantsSecondLine) {
                finalSearchParams.filter_line = '2';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_line = 2 (second line)');
            } else if (userWantsThirdLine) {
                finalSearchParams.filter_line = '3';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_line = 3 (third line)');
            }
            
            // Beach surface detection - ALWAYS check for beach changes (not just when empty)
            const userWantsSand = userTextLower.match(/песок|песч|писок|пляж.*песок|песоч/);
            const userWantsPebble = userTextLower.match(/галька|галеч|галка/);
            const userWantsMixed = userTextLower.match(/смешан|песок.*галь|галь.*песок/);
            const userWantsPlatform = userTextLower.match(/платформ|понтон/);
            
            if (userWantsSand && !userWantsPebble) {
                finalSearchParams.filter_beach_surface = 'SAND';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = SAND');
            } else if (userWantsPebble && !userWantsSand) {
                finalSearchParams.filter_beach_surface = 'PEBBLE';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = PEBBLE');
            } else if (userWantsMixed || (userWantsSand && userWantsPebble)) {
                finalSearchParams.filter_beach_surface = 'SAND+PEBBLE';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = SAND+PEBBLE');
            } else if (userWantsPlatform) {
                finalSearchParams.filter_beach_surface = 'PLATFORM';
                console.log('🔧 AUTO-SEARCH FIX: Set filter_beach_surface = PLATFORM');
            }
            
            // Ensure filter_price_max has a value (required for search)
            if (!finalSearchParams.filter_price_max) {
                // Try to extract from conversation history
                const pricePattern = /(\d{5,})/;
                for (const msg of conversationHistory) {
                    if (msg.role === 'user' && msg.content) {
                        const match = msg.content.match(pricePattern);
                        if (match) {
                            finalSearchParams.filter_price_max = match[1];
                            console.log('🔧 AUTO-SEARCH FIX: Extracted filter_price_max from history:', match[1]);
                            break;
                        }
                    }
                }
                // If still no price, use a high default
                if (!finalSearchParams.filter_price_max) {
                    finalSearchParams.filter_price_max = '500000';
                    console.log('🔧 AUTO-SEARCH FIX: Using default filter_price_max: 500000');
                }
            }
            
            // Ensure kids fields are set (required by frontend)
            if (finalSearchParams.kids === undefined || finalSearchParams.kids === null || finalSearchParams.kids === '') {
                finalSearchParams.kids = '0';
            }
            if (!finalSearchParams.kids_ages || !Array.isArray(finalSearchParams.kids_ages)) {
                finalSearchParams.kids_ages = [];
            }
            
            // Ensure from_city/from_country is set (required by frontend)
            if (!finalSearchParams.from_city && !finalSearchParams.from_country) {
                finalSearchParams.from_country = 'RU';
                finalSearchParams.from_city = 'Moscow';
            } else if (!finalSearchParams.from_city && finalSearchParams.from_country === 'RU') {
                finalSearchParams.from_city = 'Moscow';
            }
            
            // Ensure adults is set
            if (!finalSearchParams.adults) {
                finalSearchParams.adults = '2';
            }
            
            // DEFAULT: Set filter_stars to 5 if not specified
            if (!finalSearchParams.filter_stars) {
                finalSearchParams.filter_stars = '5';
                console.log('🔧 AUTO-SEARCH FIX: Using default filter_stars: 5');
            }
            
            // Reset page_number for new filter search
            finalSearchParams.page_number = 1;
            finalChatMode = false;
            
            console.log('🔧 AUTO-SEARCH FIX: Final searchParams:', JSON.stringify(finalSearchParams, null, 2));
        } else if (shouldForceChatModeFalse) {
            // AI returned complete params but chatMode: true - force chatMode to false
            console.log('🔧 FORCE CHAT MODE FIX: AI said "Ищу" with complete params but chatMode=true. Forcing chatMode=false.');
            finalChatMode = false;
            
            // Apply user's parameter changes (nights, adults, budget, date)
            if (Object.keys(paramChanges).length > 0) {
                Object.assign(finalSearchParams, paramChanges);
                console.log('🔧 FORCE CHAT MODE FIX: Applied param changes:', paramChanges);
            }
            
            // Also extract filter from user message and apply to finalSearchParams
            const userTextLower = text.toLowerCase();
            
            // Meals detection - check if user wants to CHANGE meals
            const userWantsBreakfast = userTextLower.match(/толко\s*завтр|только\s*завтр|завтрак|завтрик|зафтр/);
            const userWantsHalfBoard = userTextLower.match(/полупансион|завтрак.*ужин|ужин.*завтрак/);
            const userWantsFullBoard = userTextLower.match(/полный\s*пансион|трёхразов|трехразов/);
            const userWantsAI = userTextLower.match(/(все|всё).*(включ|вклуч)/) && !userTextLower.match(/у[ль]?тра/);
            const userWantsUAI = userTextLower.match(/у[ль]?тра.*(включ|вклуч)/);
            const userDoesntWantUAI = userTextLower.match(/не\s*хочу.*(у[ль]?тра|все.*включ|всё.*включ)/);
            
            // Apply meal changes based on user request
            if (userWantsBreakfast || userDoesntWantUAI) {
                finalSearchParams.filter_meals = 'BB';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = BB (breakfast only)');
            } else if (userWantsHalfBoard) {
                finalSearchParams.filter_meals = 'HB';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = HB (half board)');
            } else if (userWantsFullBoard) {
                finalSearchParams.filter_meals = 'FB';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = FB (full board)');
            } else if (userWantsUAI) {
                finalSearchParams.filter_meals = 'UAI';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = UAI (ultra all inclusive)');
            } else if (userWantsAI) {
                finalSearchParams.filter_meals = 'AI';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_meals = AI (all inclusive)');
            }
            
            // Check for stars
            if (userTextLower.match(/толко\s*5|только\s*5|5\s*зв|5\s*звод|пять\s*зв/)) {
                finalSearchParams.filter_stars = '5';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_stars = 5');
            } else if (userTextLower.match(/толко\s*4|только\s*4|4\s*зв|4\s*звод|четыре\s*зв/)) {
                finalSearchParams.filter_stars = '4';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_stars = 4');
            } else if (userTextLower.match(/толко\s*3|только\s*3|3\s*зв|3\s*звод|три\s*зв/)) {
                finalSearchParams.filter_stars = '3';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_stars = 3');
            }
            
            // Check for line filter
            const userWantsFirstLine = userTextLower.match(/перв.*лин|1.*лин|первая\s*лин|первой\s*лин|на\s*первой|у\s*моря|beachfront/);
            const userWantsSecondLine = userTextLower.match(/втор.*лин|2.*лин|вторая\s*лин|второй\s*лин|на\s*второй/);
            const userWantsThirdLine = userTextLower.match(/трет.*лин|3.*лин|третья\s*лин|третьей\s*лин|на\s*третьей/);
            
            if (userWantsFirstLine) {
                finalSearchParams.filter_line = '1';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_line = 1 (first line)');
            } else if (userWantsSecondLine) {
                finalSearchParams.filter_line = '2';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_line = 2 (second line)');
            } else if (userWantsThirdLine) {
                finalSearchParams.filter_line = '3';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_line = 3 (third line)');
            }
            
            // Check for beach surface filter
            const userWantsSand = userTextLower.match(/песок|песч|писок|пляж.*песок|песоч/);
            const userWantsPebble = userTextLower.match(/галька|галеч|галка/);
            const userWantsMixed = userTextLower.match(/смешан|песок.*галь|галь.*песок/);
            const userWantsPlatform = userTextLower.match(/платформ|понтон/);
            
            if (userWantsSand && !userWantsPebble) {
                finalSearchParams.filter_beach_surface = 'SAND';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = SAND');
            } else if (userWantsPebble && !userWantsSand) {
                finalSearchParams.filter_beach_surface = 'PEBBLE';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = PEBBLE');
            } else if (userWantsMixed || (userWantsSand && userWantsPebble)) {
                finalSearchParams.filter_beach_surface = 'SAND+PEBBLE';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = SAND+PEBBLE');
            } else if (userWantsPlatform) {
                finalSearchParams.filter_beach_surface = 'PLATFORM';
                console.log('🔧 FORCE CHAT MODE FIX: Set filter_beach_surface = PLATFORM');
            }
            
            // Reset page_number for new filter search
            finalSearchParams.page_number = 1;
            
            console.log('🔧 FORCE CHAT MODE FIX: Final searchParams:', JSON.stringify(finalSearchParams, null, 2));
        } else if (aiSaysSearching || userMakingChanges) {
            console.log('⚠️ AUTO-SEARCH NOT TRIGGERED: AI says "Ищу" or user making changes, but conditions not met');
            console.log('   - aiSaysSearching:', aiSaysSearching);
            console.log('   - userAddingFilter:', !!userAddingFilter);
            console.log('   - userChangingParams:', !!userChangingParams);
            console.log('   - paramChanges:', paramChanges);
            console.log('   - hasCoreFields:', hasCoreFields);
            console.log('   - hadPreviousSearch:', hadPreviousSearch);
            console.log('   - hadSearchFromParams:', hadSearchFromParams);
            console.log('   - canAutoSearch:', canAutoSearch);
            console.log('   - aiHasIncompleteParams:', aiHasIncompleteParams);
            console.log('   - combinedParams:', JSON.stringify(combinedParams, null, 2));
        }
  return { finalChatMode, finalSearchParams };
}
module.exports = { applyAutoSearchFix };
