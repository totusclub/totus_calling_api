#!/usr/bin/env node
/**
 * Simulate 20 confused Russian-speaking users trying to find tours locally.
 * Usage: node scripts/simulate-20-users.js [--seed=12345]
 */
const fs = require('fs');
const path = require('path');

const SIM_DATA_DIR = path.join(__dirname, '../data/simulation-20-users');
process.env.TOUR_ASSISTANT_V2_DATA_DIR = SIM_DATA_DIR;

const seedArg = process.argv.find((a) => a.startsWith('--seed='));
const SEED = seedArg ? Number(seedArg.split('=')[1]) : Date.now();

function mulberry32(a) {
  return function rand() {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickInt = (min, max) => min + Math.floor(rand() * (max - min + 1));

const {
  KNOWN_CITY_RESOLVES,
  COUNTRY_QUERY_ALIASES,
} = require('../tour-assistant/v2/destination.catalog');

const FROM_CITIES = ['москва', 'питер', 'казань', 'екатеринбург'];
const MONTHS = ['июня', 'июля', 'августа', 'сентября', 'октября', 'ноября'];
const MEALS = ['все включено', 'завтрак', 'без питания', 'полупансион'];
const STYLES = ['cooperative', 'cooperative', 'cooperative', 'slow', 'minimal', 'country_only', 'city_only', 'one_shot'];
const NAMES = [
  'Марина', 'Алексей', 'Ольга', 'Денис', 'Елена', 'Игорь', 'Светлана', 'Павел',
  'Анна', 'Кирилл', 'Наталья', 'Виктор', 'Юлия', 'Роман', 'Татьяна', 'Максим',
  'Лариса', 'Артём', 'Вера', 'Григорий',
];

/** Best Russian query form per country (accusative / common speech). */
const COUNTRY_SPEAK_FORMS = {
  TR: ['турцию', 'турция'],
  EG: ['египет', 'египта'],
  TH: ['таиланд', 'таиланд'],
  GR: ['грецию', 'греция'],
  ES: ['испанию', 'испанию'],
  CY: ['кипр', 'кипр'],
  AE: ['оаэ', 'дубай'],
  MV: ['мальдивы', 'малдиви'],
  ID: ['бали', 'индонезию'],
  VN: ['вьетнам', 'вьетнам'],
  MA: ['марокко', 'марокко'],
  TN: ['тунис', 'тунис'],
  IT: ['италию', 'италию'],
  FR: ['францию', 'францию'],
  LK: ['шри-ланку', 'шри ланка'],
  OM: ['оман', 'оман'],
  QA: ['катар', 'катар'],
  JO: ['иорданию', 'иорданию'],
  ME: ['черногорию', 'черногорию'],
  HR: ['хорватию', 'хорватию'],
  IN: ['индию', 'гоа'],
  MX: ['мексику', 'мексику'],
  DO: ['доминикану', 'пунта-кана'],
  GE: ['грузию', 'грузию'],
  AZ: ['азербайджан', 'баку'],
  PT: ['португалию', 'португалию'],
  DE: ['германию', 'германию'],
  AT: ['австрию', 'австрию'],
  CH: ['швейцарию', 'швейцарию'],
  CZ: ['чехию', 'чехию'],
  US: ['сша', 'сша'],
  AM: ['армению', 'армению'],
  TZ: ['занзибар', 'занзибар'],
  SC: ['сейшелы', 'сейшелы'],
  MU: ['маврикий', 'маврикий'],
  CU: ['кубу', 'кубу'],
  CN: ['китай', 'санья'],
  JP: ['японию', 'японию'],
  KR: ['корею', 'корею'],
};

function buildDestinationPool() {
  const cities = [];
  const seenCity = new Set();
  for (const [alias, dest] of Object.entries(KNOWN_CITY_RESOLVES)) {
    if (!/[а-яё]/i.test(alias)) continue;
    const key = `${dest.country}:${dest.city}`;
    if (seenCity.has(key)) continue;
    seenCity.add(key);
    cities.push({ alias, country: dest.country, city: dest.city });
  }

  const countries = [];
  const seenCountry = new Set();
  for (const [alias, code] of Object.entries(COUNTRY_QUERY_ALIASES)) {
    if (!/[а-яё]/i.test(alias) || alias.length < 4) continue;
    if (seenCountry.has(code)) continue;
    if (code === 'RU') continue;
    seenCountry.add(code);
    const forms = COUNTRY_SPEAK_FORMS[code] || [alias];
    countries.push({ alias: forms[0], country: code, speak: forms });
  }

  return { cities, countries };
}

const { cities: CITY_POOL, countries: COUNTRY_POOL } = buildDestinationPool();

function randomPlan(dest) {
  const day = pickInt(1, 25);
  const month = pick(MONTHS);
  const nights = pickInt(5, 14);
  const adults = pickInt(1, 3);
  const kids = rand() < 0.25 ? pickInt(1, 2) : 0;
  return {
    destination: dest.alias,
    expectedCountry: dest.country,
    expectedCity: dest.city || null,
    from_city: pick(FROM_CITIES),
    start_date: `${day} ${month}`,
    nights,
    adults,
    kids,
    kids_ages: kids > 0 ? '8 и 10' : undefined,
    budget: pickInt(100, 450) * 1000,
    meals: pick(MEALS),
  };
}

function buildOpening(style, plan, dest) {
  const { from_city, start_date, nights, adults, budget, meals, destination } = plan;
  switch (style) {
    case 'one_shot':
      return `найди тур из ${from_city} в ${destination} ${start_date} на ${nights} ночей ${adults} взрослых до ${budget} ${meals}`;
    case 'country_only':
      return `хочу в ${destination}`;
    case 'city_only':
      return rand() < 0.5 ? `хочу в ${destination}` : destination;
    case 'slow':
      return pick(['привет', 'здравствуйте', 'добрый день', 'помогите найти тур']);
    case 'minimal':
      return pick(['тур', 'отпуск', 'на море', `в ${destination}`]);
    default:
      return pick([
        `хочу в ${destination}`,
        `найди тур в ${destination}`,
        `летим в ${destination}`,
        `${destination} летом`,
      ]);
  }
}

function generateRandomPersonas(count) {
  const personas = [];
  const used = new Set();

  for (let i = 1; i <= count; i++) {
    const useCity = rand() < 0.55;
    let dest;
    let attempts = 0;
    do {
      dest = useCity ? pick(CITY_POOL) : pick(COUNTRY_POOL);
      attempts++;
    } while (used.has(`${dest.country}:${dest.city || dest.alias}`) && attempts < 30);
    used.add(`${dest.country}:${dest.city || dest.alias}`);

    const style = pick(STYLES);
    const plan = randomPlan(dest);
    const persona = {
      id: i,
      name: NAMES[i - 1] || `User${i}`,
      type: `${style} → ${dest.country}${dest.city ? '/' + dest.city : ''}`,
      opening: buildOpening(style, plan, dest),
      plan,
      style: style === 'country_only' || style === 'city_only' ? 'cooperative' : style,
      seedDest: dest,
    };
    personas.push(persona);
  }
  return personas;
}

const PERSONAS = generateRandomPersonas(20);

if (fs.existsSync(SIM_DATA_DIR)) {
  for (const f of fs.readdirSync(SIM_DATA_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(SIM_DATA_DIR, f));
  }
} else {
  fs.mkdirSync(SIM_DATA_DIR, { recursive: true });
}

const v2 = require('../tour-assistant/v2/v2.service');
const { getNextMissingField } = require('../tour-assistant/v2/conversation.state');

function replyForMissingField(field, plan, style) {
  const p = plan || {};
  switch (field) {
    case 'search_intent':
      return style === 'minimal' ? 'тур' : 'хочу тур с перелётом и отелем';
    case 'from_city':
      return p.from_city || 'москва';
    case 'destination':
      return p.destination || 'турцию';
    case 'start_date':
      return p.start_date || '15 июля';
    case 'nights':
      return String(p.nights || 7);
    case 'adults':
      return String(p.adults || 2);
    case 'kids':
      return String(p.kids ?? 0);
    case 'kids_ages':
      return p.kids_ages || '8 и 10';
    case 'filter_price_max':
      return String(p.budget || 200000);
    case 'filter_meals':
      return p.meals || 'все включено';
    default:
      return 'да';
  }
}

function lastAssistantText(conv) {
  const msgs = conv.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return msgs[i].content || '';
  }
  return '';
}

function hasEnglishGarbage(text) {
  return /Aegean|Turkey\b|Sea Turkey|Hurghada Governorate/i.test(text || '');
}

function analyzeTurn(conv, userText, turnIdx) {
  const hotels = conv.results?.hotels || [];
  const lastReply = lastAssistantText(conv);
  return {
    turn: turnIdx,
    user: userText,
    stage: conv.state,
    collectionStep: conv.collectionStep,
    assistantPreview: (lastReply || '').slice(0, 200),
    hotelsCount: hotels.length,
    destination: conv.searchParams?.destination_label || '',
    params: {
      to_country: conv.searchParams?.to_country,
      to_city: conv.searchParams?.to_city,
      from_city: conv.searchParams?.from_city,
      start_date: conv.searchParams?.start_date,
      nights: conv.searchParams?.nights,
      adults: conv.searchParams?.adults,
    },
    issues: [
      ...(hasEnglishGarbage(lastReply) ? ['english_in_reply'] : []),
      ...(lastReply.length > 400 ? ['very_long_reply'] : []),
      ...((turnIdx > 8 && conv.collectionStep !== 'complete' && hotels.length === 0) ? ['too_many_turns_no_results'] : []),
    ],
  };
}

async function runPersona(persona) {
  const { conversation } = v2.createConversation({ userId: `sim-${persona.id}`, title: persona.name });
  const convId = conversation.id;
  const turns = [];
  const maxTurns = 12;
  let followUpIdx = 0;

  let userText = persona.opening;
  for (let t = 1; t <= maxTurns; t++) {
    if (persona.pivot && t === persona.pivot.afterTurn) {
      userText = persona.pivot.message;
    } else if (t > 1) {
      const prev = v2.getConversationMessages(convId);
      const missing = getNextMissingField(prev.searchParams);
      const hotels = prev.results?.hotels?.length || 0;

      if (persona.style === 'frustrated' && hotels === 0 && persona.followUp?.[followUpIdx]) {
        userText = persona.followUp[followUpIdx++];
      } else if (persona.style === 'one_shot' && t > 1) break;
      else if (missing) {
        userText = replyForMissingField(missing, persona.plan, persona.style);
      } else if (hotels > 0) {
        userText = 'спасибо';
        await v2.processUserMessage(convId, userText);
        turns.push(analyzeTurn(v2.getConversationMessages(convId), userText, t));
        break;
      } else if (persona.style === 'frustrated' && persona.followUp?.[followUpIdx]) {
        userText = persona.followUp[followUpIdx++];
      } else {
        break;
      }
    }

    await v2.processUserMessage(convId, userText);
    const conv = v2.getConversationMessages(convId);
    turns.push(analyzeTurn(conv, userText, t));

    if (conv.collectionStep === 'complete' && (conv.results?.hotels?.length || 0) > 0) break;
    if (persona.style === 'one_shot' && conv.collectionStep === 'complete') break;
  }

  const final = v2.getConversationMessages(convId);
  const lastReply = lastAssistantText(final);
  const hotels = final.results?.hotels || [];

  return {
    id: persona.id,
    name: persona.name,
    type: persona.type,
    opening: persona.opening,
    plannedDestination: persona.plan?.destination,
    expectedCountry: persona.plan?.expectedCountry,
    expectedCity: persona.plan?.expectedCity,
    turns: turns.length,
    outcome:
      hotels.length > 0
        ? 'found_tours'
        : final.collectionStep !== 'complete'
          ? 'stuck_collecting'
          : 'no_results',
    hotelsFound: hotels.length,
    finalStep: final.collectionStep,
    finalDestination: final.searchParams?.destination_label || null,
    finalParams: final.searchParams,
    lastReply: lastReply.slice(0, 300),
    transcript: turns,
    issues: [
      ...new Set(turns.flatMap((x) => x.issues)),
      ...(hotels.length === 0 && final.collectionStep === 'complete' ? ['search_empty'] : []),
      ...(turns.length >= 10 ? ['many_turns'] : []),
      ...(final.searchParams?.to_country === 'RU' && final.searchParams?.to_city === 'Moscow'
        ? ['moscow_as_destination']
        : []),
      ...(persona.plan?.expectedCountry &&
      final.searchParams?.to_country &&
      final.searchParams.to_country !== persona.plan.expectedCountry
        ? ['wrong_country']
        : []),
    ],
  };
}

async function main() {
  console.log(`Starting 20-user RANDOM simulation (seed=${SEED})...\n`);
  console.log('Generated personas:');
  for (const p of PERSONAS) {
    console.log(`  ${p.id}. ${p.name} [${p.type}] → "${p.opening}"`);
  }
  console.log('');

  const results = [];
  const started = Date.now();

  for (const persona of PERSONAS) {
    process.stdout.write(`User ${persona.id}/20 ${persona.name}... `);
    try {
      const r = await runPersona(persona);
      results.push(r);
      console.log(`${r.outcome} (${r.turns} turns, ${r.hotelsFound} hotels)`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({
        id: persona.id,
        name: persona.name,
        type: persona.type,
        outcome: 'error',
        error: err.message,
      });
    }
  }

  const summary = {
    seed: SEED,
    runAt: new Date().toISOString(),
    durationSec: Math.round((Date.now() - started) / 1000),
    total: results.length,
    foundTours: results.filter((r) => r.outcome === 'found_tours').length,
    stuckCollecting: results.filter((r) => r.outcome === 'stuck_collecting').length,
    noResults: results.filter((r) => r.outcome === 'no_results').length,
    errors: results.filter((r) => r.outcome === 'error').length,
    avgTurns: Math.round((results.reduce((s, r) => s + (r.turns || 0), 0) / results.length) * 10) / 10,
    issueCounts: {},
  };

  for (const r of results) {
    for (const issue of r.issues || []) {
      summary.issueCounts[issue] = (summary.issueCounts[issue] || 0) + 1;
    }
  }

  const report = { summary, results };
  const outPath = path.join(__dirname, '../data/simulation-20-users-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nFull report: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
