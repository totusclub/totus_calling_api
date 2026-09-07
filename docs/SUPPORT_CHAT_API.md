# Support Chat — API calling_api_v2 (voip.totus.club)

Чат пользователя (сайт / приложение / desktop) со службой поддержки. Модуль `lib/supportChat.js`,
подключён через `middleware/auth.js` (POLICY-handler для HTTP, `attachSocket` в `socketGate`).
Полный план: проект Totus Dev → `claude/SUPPORT_CHAT_PLAN_RU.md`; макеты — `claude/SUPPORT_CHAT_DESIGN_RU.md`.

## Установка

```bash
git pull                                   # ветка prod
node scripts/run-support-chat-migration.js # таблицы support_chats / support_messages (идемпотентно)
pm2 restart api_calling
pm2 logs api_calling | grep support-chat   # ожидается: [support-chat] ready
```

Без таблиц сервис не падает: все `/api/support/*` отвечают `503 {"error":"support_chat_not_migrated"}`,
в логе — подсказка про миграцию. Необязательные переменные `.env`: `SUPPORT_CHAT_RATE_LIMIT` (30 сообщений/мин
на пользователя), `SUPPORT_HOURS_TEXT` (текст о часах работы для пустого состояния).

## Роли и авторизация

`Authorization: Bearer <JWT>` от totus_API. Все роуты — `requireAuth(..., {strict: true})`: работают в 401/403 даже
при `AUTH_MODE=log`. Личность (user_id / staff_id) берётся только из токена.

| Сторона | Роли | Пути |
|---|---|---|
| пользователь | `user` (agent тоже удовлетворяет) | `/api/support/chat*` |
| поддержка | `agent` (панель calling_v2), `staff` (админка) | `/api/support/chats*`, `/api/support/summary` |

Один диалог на пользователя: `GET /api/support/chat` создаёт его при первом обращении.
Статусы: `open` — ждёт ответа поддержки, `pending` — поддержка ответила, ждём пользователя, `closed` — закрыт
(новое сообщение пользователя переоткрывает в `open`).

## REST — пользователь

| Метод | Путь | Тело / query | Ответ |
|---|---|---|---|
| GET | `/api/support/chat` | `?limit=50` | `{chat, messages[], hasMore, hours:{open,close,tz,text}}` |
| GET | `/api/support/chat/messages` | `?before=<messageId>&limit=50` | `{messages[], hasMore}` — страница истории вверх |
| POST | `/api/support/chat/messages` | `{body, clientMsgId?, meta?:{orderId, orderTitle?, orderSubtitle?, topic?}}` | `201 {ok, chat, message}` (повтор `clientMsgId` → `200`, то же сообщение) |
| POST | `/api/support/chat/read` | `{lastMessageId?}` | `{ok, chat}` — обнуляет `userUnread` |

## REST — поддержка

| Метод | Путь | Тело / query | Ответ |
|---|---|---|---|
| GET | `/api/support/summary` | — | `{openCount, pendingCount, unreadTotal, unreadChats}` |
| GET | `/api/support/chats` | `?status=open|pending|closed|all&q=&limit=50&offset=0&assigned=me|none` | `{data: chat[], total, limit, offset}`; непрочитанные — первыми |
| GET | `/api/support/chats/:id` | `?limit=50` | `{chat, messages[], hasMore}` |
| GET | `/api/support/chats/:id/messages` | `?before&limit` | `{messages[], hasMore}` |
| POST | `/api/support/chats/:id/messages` | `{body, clientMsgId?}` | `201 {ok, chat, message}`; статус → `pending`, `userUnread+1`, диалог закрепляется за отправителем, если свободен |
| POST | `/api/support/chats/:id/read` | `{lastMessageId?}` | `{ok, chat}` — обнуляет `staffUnread` |
| POST | `/api/support/chats/:id/assign` | `{unassign?: true}` | `{ok, chat}` — взять себе / снять |
| POST | `/api/support/chats/:id/status` | `{status}` | `{ok, chat}` |

Ошибки: `400 body_required | message_too_long (>4000) | invalid_status | chat_id_required`, `404 chat_not_found`,
`429 rate_limited`, `503 support_chat_not_migrated`, `401/403` — auth.

## Объекты

```jsonc
chat: { id, userId, status, assignedId, assignedRole, assignedName, subject, orderId,
        lastMessageId, lastMessageAt, lastMessagePreview, userUnread, staffUnread, createdAt, updatedAt,
        user: { id, name, email, phone, loyaltyId, online } }
message: { id, chatId, senderRole: "user|staff|agent|system", senderId, senderName, body,
           meta: null | { orderId, orderTitle, orderSubtitle, topic }, clientMsgId, readAt, createdAt }
```

## Socket.io (тот же namespace, что и звонки)

Подключение как раньше: `io(BASE_URL, { transports:['websocket'], auth: { token } })`. По токену сокет попадает
в комнаты: `u:<userId>` (user/agent), `support:staff` (agent/staff). Без токена — комнат нет, чат работает по REST.

Клиент → сервер (все с ack `cb(result)`):

| Событие | Payload | Ack |
|---|---|---|
| `support:send` | `{chatId? (только поддержка), body, clientMsgId?, meta?}` | `{ok, chat, message, duplicate}` / `{ok:false, error}` |
| `support:read` | `{chatId? (только поддержка), lastMessageId?}` | `{ok}` |
| `support:typing` | `{chatId? (только поддержка), typing:bool}` | — |
| `support:subscribe` / `support:unsubscribe` | `{chatId}` (поддержка; для адресных typing) | — |

Сервер → клиент:

| Событие | Кому | Payload |
|---|---|---|
| `support:message` | `u:<userId>`, `support:staff` | `{chat, message}` |
| `support:chat-updated` | `u:<userId>`, `support:staff` | `{chat}` (assign / status) |
| `support:read` | противоположной стороне | `{chatId, by:'user'|'staff', lastMessageId, chat}` |
| `support:typing` | `u:<userId>` или `chat:<id>` + `support:staff` | `{chatId, from:'user'|'staff', typing}` |

Сигнализация звонков (`registerDevice`, `offer`, `answer`, `ice-candidate`, `call-state`) не менялась.

## Push

Если у пользователя нет живого сокета, при ответе поддержки отправляется FCM (Android) по `users.voipToken`,
когда это FCM-токен: `notification {title:'Поддержка Totus', body}` + `data {type:'support_message', chatId, messageId}`.
iOS: в приложении зарегистрирован только PushKit VoIP-токен — уведомления о сообщениях на iOS пока не отправляются (этап 2).

## Проверка

```bash
npm run check                # node --check index.js + auth-ядро + scripts/check-support-chat.js
# ручной сценарий (token_user / token_staff — JWT totus_API):
curl -H "Authorization: Bearer $U" https://voip.totus.club/api/support/chat
curl -H "Authorization: Bearer $U" -H 'Content-Type: application/json' -d '{"body":"Здравствуйте!"}' https://voip.totus.club/api/support/chat/messages
curl -H "Authorization: Bearer $S" "https://voip.totus.club/api/support/chats?status=open"
curl -H "Authorization: Bearer $S" -H 'Content-Type: application/json' -d '{"body":"Добрый день, чем помочь?"}' https://voip.totus.club/api/support/chats/1/messages
```
