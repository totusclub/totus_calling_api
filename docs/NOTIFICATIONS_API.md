# Хаб уведомлений calling_api_v2 — API

Единая точка отправки push/in-app уведомлений для всей платформы (план: `claude/PUSH_NOTIFICATIONS_PLAN_RU.md`, дизайн: `claude/NOTIFICATIONS_DESIGN_RU.md`). Код: `lib/notifications/`. Подключён через `middleware/auth.js` (POLICY handler + socketGate), `index.js` не менялся.

Базовый URL — тот же, что у звонков и Support Chat: `https://voip.totus.club:4444`. Все пользовательские запросы — `Authorization: Bearer <user-JWT>` (agent тоже подходит), сотрудники — `Bearer <staff-JWT>`. Роуты strict: 401/403 независимо от `AUTH_MODE`. Пока миграция не выполнена — `503 {error:"notifications_not_migrated"}`.

## 1. Установка (владелец)

```
npm install                                  # + web-push
node scripts/run-notifications-migration.js  # push_devices, notifications, notification_settings, push_campaigns, push_reminder_rules, push_reminder_log
node scripts/generate-vapid-keys.js          # → VAPID_* в .env
openssl rand -hex 32                         # → INTERNAL_API_KEY (тот же в .env totus_API)
pm2 restart api_calling
npm run check                                # scripts/check-notifications.js — без БД
```

В консоли Firebase (проект приложения) загрузить APNs-ключ `.p8` (Cloud Messaging → Apple app configuration) — иначе iOS-пуши через FCM не уходят. `FIREBASE_CREDENTIALS_PATH` уже используется для звонков Android.

Лог при старте: `[notify] ready (fcm=on|off, webpush=on|off, quiet=21:00-09:00)`.

## 2. Типы и категории

| Тип | Категория (настройка) | Маршрут по умолчанию | Источник |
|---|---|---|---|
| `order_created`, `payment_success`, `payment_failed`, `order_request_status` | `orders` «Заказы и оплата» — нельзя отключить | `order` / `order_request` | totus_API |
| `order_confirmed`, `order_status`, `order_cancelled`, `documents_ready` | `documents` «Документы и статусы тура» — нельзя отключить | `order` / `documents` | totus_API (webhook LT) |
| `trip_reminder` | `reminders` «Напоминания о поездке» (вкл) | `order` | правила из админки (движок в хабе) |
| `support_message`, `missed_call` | `support` «Сообщения поддержки» (вкл) | `support_chat` / `account` | хаб |
| `promo` | `promo` «Акции и предложения» (**выкл**, opt-in, тихие часы) | `home` / `url` | рассылки из админки |
| `system` | `system` «Важное» — нельзя отключить | `home` | админка / totus_API |

Маршруты (`data.route`): `home, order, orders, documents, order_request, support_chat, account, notifications, url, search`. Данные к маршруту: `data.orderId`, `data.chatId`, `data.url` (только http/https), `data.notificationId`. Android-каналы (создаёт приложение): `orders`, `reminders`, `support_chat`, `promo`, `system`.

Правило текстов: заголовок ≤ 40 символов на экране (в API до 160), текст ≤ 120 (в API до 512), без персональных данных — только номер заказа, маршрут, дата.

## 3. Пользователь (приложение / сайт / desktop)

### Устройства

`POST /api/push/devices` — регистрация после входа и при обновлении токена (upsert по токену; чужой токен пере-привязывается к текущему пользователю).

```json
{ "platform": "ios|android|web|desktop", "channel": "fcm|webpush",
  "token": "<FCM-токен>",                                  // fcm
  "subscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } },  // webpush
  "deviceId": "<стабильный id установки>", "deviceName": "iPhone Ивана", "appVersion": "2.4.0", "locale": "ru" }
```
→ `{ ok, device: {id, platform, channel, deviceId, deviceName, enabled, tokenTail, lastSeenAt}, unread }`. Ошибки: `platform_invalid`, `token_invalid`, `subscription_invalid`.

`DELETE /api/push/devices` тело `{ token }` | `{ subscription }` | `{ deviceId }` — при выходе. `DELETE /api/push/devices/:token` — то же. `GET /api/push/devices` — свои устройства.

`GET /api/push/vapid-public-key` (публично) → `{ publicKey }` для `pushManager.subscribe({ applicationServerKey })`.

### Центр уведомлений

- `GET /api/notifications?before=<id>&limit=30&category=orders&unread=1` → `{ items: [{id, type, category, title, body, data, source, readAt, openedAt, createdAt}], hasMore, unread }`.
- `GET /api/notifications/unread` → `{ unread }`.
- `POST /api/notifications/read` `{ ids: [..] }` | `{ id }` | `{ all: true }` → `{ ok, unread }`.
- `POST /api/notifications/opened` `{ id }` — тап по пушу/элементу (статистика «открыто», помечает прочитанным) → `{ ok, unread }`.
- `DELETE /api/notifications/:id`.
- `GET /api/notifications/meta` → категории, типы, маршруты, `quietHours`, `push: {fcm, webpush, vapidPublicKey}`.

### Настройки

`GET /api/notifications/settings` → `{ settings: { prefs: {orders, documents, reminders, support, promo, system}, email, sound, categories: [{key, title, mandatory, enabled}], quietHours }, devices: [...] }`.
`PUT /api/notifications/settings` `{ prefs: { promo: true, reminders: false }, email: true, sound: false }` — обязательные категории всегда `true`.

### Socket (тот же namespace, что звонки и Support Chat; токен в `auth.token`)

Сервер → клиент (комната `u:<userId>` — все устройства пользователя):
- `notify:new` `{ id, type, category, title, body, data, createdAt }` — показать тост/системное уведомление, обновить список;
- `notify:badge` `{ unread }` — бейдж.

Клиент → сервер (с ack): `notify:badge` → `{ok, unread}`; `notify:read` `{ ids | id | all: true }`; `notify:opened` `{ id }`.

Push приходит **и** при живом сокете (кроме `support_message`, где действует прежнее правило «только без живого сокета»); клиент в foreground сам решает, показывать ли системный баннер (приложение — через notifee, сайт/desktop — через `notify:new`).

## 4. Payload пуша

FCM (`data` — только строки): `type, route, title, body, notificationId, orderId?, chatId?, url?, campaignId?, ruleId?`; `notification {title, body}`; Android `channelId` по типу, `tag` = collapseKey; iOS `aps.alert/sound/badge/thread-id`, `mutable-content: 1`, `apns-collapse-id`.
Web Push (JSON для `public/sw.js`): `{ title, body, icon: "/icons/icon-192.png", badge: "/icons/badge-72.png", tag, renotify, data: {…то же…} }`.

Мёртвые токены (`registration-token-not-registered`, Web Push 404/410) удаляются автоматически; 5 временных ошибок подряд — устройство отключается до следующей регистрации.

## 5. Внутренний API (totus_API → хаб)

`POST /internal/notify`, заголовок `X-Internal-Key: <INTERNAL_API_KEY>` (без ключа/с неверным — 401; ключ не настроен — 503). Тело — объект или массив (≤100):

```json
{ "userId": 42, "type": "payment_success", "title": "Оплата прошла",
  "body": "Заказ №48213 оплачен. Документы будут готовы в течение 15 минут.",
  "data": { "orderId": "48213", "route": "order" }, "collapseKey": "order_48213" }
```
Адресат: `userId` | `userIds` | `loyaltyId`. Необязательно: `channels {inapp, push}`, `respectQuietHours` (по умолчанию только для `promo`), `skipIfOnline`, `silent`, `ttlSeconds`, `source`.
Ответ: `{ ok, recipients, inapp, push: {sent, failed, dead}, deferred, skipped, ids? }`; ошибки 400 `type_invalid | user_required | body_required`, 404 `user_not_found`.
`GET /internal/health` → `{ ok, fcm, webpush, quietNow }`.

Рекомендуемые тексты (totus_API): `order_created` «Заказ №{n} ожидает оплаты», `payment_success` «Оплата прошла — документы будут готовы в течение 15 минут», `payment_failed` «Оплата не прошла. Попробуйте ещё раз», `order_confirmed` «Тур подтверждён туроператором», `documents_ready` «Документы по заказу №{n} готовы», `order_cancelled` «Заказ №{n} отменён», `order_request_status` «Ответ по обращению №{n}».

## 6. Сотрудник (Totus_admin, staff-JWT) — `/api/push/*`

- `GET /api/push/status` — fcm/webpush/internalKey, тихие часы, справочники (категории, типы, маршруты, события/единицы правил).
- `GET /api/push/stats?from&to` — сводка: `notifications {total, inapp, pushSent, pushFailed, pushDeferred, noDevices, opened, read, tokenErrors}`, `devices {total, enabled, ios, android, web, desktop}`, `byType`. По умолчанию — 30 дней.
- `GET /api/push/history?q&type&category&status&userId&campaignId&ruleId&source&from&to&before&limit` — история (вкладка «История»): элементы + `user {name, email, loyaltyId}`, `pushStatus (none|pending|deferred|sent|failed|no_devices|skipped)`, `source` (`system` / `campaign:<id>` / `reminder:<id>` / `support_chat` / `totus_api` / `test`).
- `GET /api/push/users/:id/devices` — устройства, настройки, непрочитанные пользователя (карточка пользователя).
- `POST /api/push/test` `{ userId | loyaltyId | email, title?, body?, type? }` — «Тестовый пуш себе» (по умолчанию — пользователь с e-mail сотрудника).

### Рассылки

- `POST /api/push/campaigns/audience` `{ segment, type }` → `{ audience: {users, devices} }` — «Сколько получателей».
- `POST /api/push/campaigns` `{ title, body, type: "promo|system", data: {route, url}, segment, respectQuietHours, scheduledAt?, dryRun?, draft? }` — `dryRun` → только подсчёт; `draft` → черновик; `scheduledAt` в будущем → `scheduled`; иначе отправка сразу (`status: sending`, результат — в `GET /campaigns/:id`).
  Сегмент: `{ platforms: [...], hasOrders: true, departureFrom: "2026-10-01", departureTo: "2026-10-15", userIds: [...] }`, пусто = все. Для `promo` аудитория дополнительно фильтруется по согласию (`prefs.promo = true`).
- `GET /api/push/campaigns?before&limit&status`, `GET /api/push/campaigns/:id` → `{ campaign: {id, title, body, type, data, segment, status, respectQuietHours, scheduledAt, audienceCount, deviceCount, sentCount, failedCount, openedCount, inappCount, error, staff, startedAt, finishedAt, createdAt} }`.
- `PUT /api/push/campaigns/:id` (draft/scheduled), `POST /api/push/campaigns/:id/send`, `POST /api/push/campaigns/:id/cancel`, `DELETE /api/push/campaigns/:id` (draft/cancelled/failed).

Тихие часы 21:00–09:00 МСК (`PUSH_QUIET_HOURS`): при `respectQuietHours` пуш откладывается до 09:00 (`push_status = deferred`, in-app появляется сразу), в кампании это видно как `error: "deferred:<n>"` до отправки.

### Напоминания (правила)

- `GET /api/push/reminders` → `{ rules: [{id, name, enabled, event, offsetValue, offsetUnit, offsetDirection, sendTime, quietBehavior, type, title, body, channels, audience, sentCount, openedCount, lastRunAt, lastSentAt}] }`.
- `POST /api/push/reminders`, `PUT /api/push/reminders/:id` — тело: `name`, `event: departure|checkin|trip_end|order_created`, `offsetValue` (0–365), `offsetUnit: hours|days`, `offsetDirection: before|after`, `sendTime: "10:00"` (МСК, для дней), `quietBehavior: shift|skip|send`, `type` (по умолчанию `trip_reminder`), `title`, `body` (переменные `{имя} {номер} {город} {страна} {отель} {дата_вылета} {время_вылета} {аэропорт} {ночей} {дата_окончания}`), `channels: {push, inapp, email}`, `audience: paid|all`, `enabled`.
- `POST /api/push/reminders/preview` → `{ preview: {title, body} }` на примерных данных; `POST /api/push/reminders/:id/test` `{ userId|loyaltyId|email }` — тест себе по последнему заказу; `POST /api/push/reminders/:id/toggle` `{ enabled? }`; `DELETE /api/push/reminders/:id`; `POST /api/push/reminders/run` — прогнать движок вручную.

Движок: раз в 10 минут проходит по `orders` (факты из JSON `orders.package`: `start_date`, `nights`/`end_date`, `hotel.name/city`, `flights.to.departure_time/departure_airport`), считает момент отправки, окно — 24 ч после момента (пропущенное не догоняет), один раз на пару правило+заказ (`push_reminder_log`). Канал `email` в правилах только сохраняется — письма шлёт totus_API (следующий этап).
Миграция создаёт два выключенных правила: «За 3 дня до вылета» (10:00) и «За сутки до вылета».

## 7. Пропущенные звонки

`POST /api/calls` от agent/staff (звонок поддержки пользователю по `toLoyaltyId`) ставит таймер 45 с; `answer`/`reject` (HTTP или socket) снимают его; `end` до ответа или истечение таймера → `missed_call` пользователю («Поддержка Totus звонила вам…», маршрут `account`). Реализовано tap-функциями POLICY в `middleware/auth.js`, логика звонков не менялась.

## 8. Ошибки

`400` — валидация (`type_invalid`, `body_required`, `title_required`, `platform_invalid`, `token_invalid`, `subscription_invalid`, `offset_invalid`, `send_time_invalid`, `segment_departure_invalid`, `scheduled_at_invalid`), `401/403` — токен/роль, `404 not_found | user_not_found`, `409 campaign_status_invalid | already_sending`, `503 notifications_not_migrated | internal_key_not_configured`.
