'use strict';
// Единая точка доступа к секретам calling_api_v2 (Б.1, SECURITY_AUDIT_SECRETS_RU.md).
// Никаких fallback-литералов и ключевых файлов в репозитории.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) { /* dotenv optional */ }

const REQUIRED = {
  DB_HOST: 'MySQL (та же база kedam, что у totus_API)',
  DB_USER: 'MySQL',
  DB_PASSWORD: 'MySQL',
  DB_NAME: 'MySQL',
  JWT_SECRET: 'подпись access-токенов — то же значение, что у totus_API',
  JWT_REFRESH_SECRET: 'подпись refresh-токенов — то же значение, что у totus_API',
};
const OPTIONAL = {
  APN_KEY_PATH: 'путь к APNs .p8 ВНЕ репозитория (без него VoIP-пуши на iOS отключены)',
  APN_KEY_ID: 'APNs Key ID',
  APN_TEAM_ID: 'Apple Team ID',
  APN_PRODUCTION: '1 (по умолчанию) / 0 = sandbox',
  FIREBASE_CREDENTIALS_PATH: 'путь к JSON Firebase Admin SDK вне репозитория (FCM-пуши Android)',
  GOOGLE_APPLICATION_CREDENTIALS: 'путь к JSON сервисного аккаунта Google TTS вне репозитория',
  DEEPSEEK_API_KEY: 'ключ DeepSeek для legacy tour-assistant (без него эндпоинты ИИ отвечают ошибкой)',
  TURN_SECRET: 'static-auth-secret coturn (use-auth-secret) — ephemeral-креды /api/ice-servers',
  TURN_STATIC_USERNAME: 'переходный вариант: статический TURN-логин из .env',
  TURN_STATIC_CREDENTIAL: 'переходный вариант: статический TURN-пароль из .env',
  DB_PORT: 'порт MySQL (3306)',
  CORS_ORIGINS: 'whitelist origin\'ов',
  AUTH_MODE: 'log | enforce',
  SUPPORT_CHAT_RATE_LIMIT: 'Support Chat: сообщений в минуту от одного пользователя (30)',
  SUPPORT_HOURS_TEXT: 'Support Chat: текст о часах работы в пустом состоянии чата',
};

function env(name) {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : String(v);
}

/** Обязательная переменная: понятная ошибка при использовании, если не задана. */
function requireEnv(name) {
  const v = env(name);
  if (!v) throw new Error(`[ENV] ${name} is not set (${REQUIRED[name] || OPTIONAL[name] || 'см. .env.example'})`);
  return v;
}

/** Отчёт при старте: что не задано. Процесс не роняет. */
function reportEnv() {
  const missing = Object.keys(REQUIRED).filter((k) => !env(k));
  const missingOpt = Object.keys(OPTIONAL).filter((k) => !env(k));
  if (missing.length) console.error(`[ENV] MISSING required: ${missing.join(', ')} — заполните .env (см. .env.example)`);
  else console.log('[ENV] all required variables present');
  if (missingOpt.length) console.warn(`[ENV] optional not set: ${missingOpt.join(', ')}`);
  return { missing, missingOpt };
}

module.exports = { env, requireEnv, reportEnv, REQUIRED, OPTIONAL };
