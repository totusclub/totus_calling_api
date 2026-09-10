// Генерация VAPID-ключей для Web Push: node scripts/generate-vapid-keys.js
// Без зависимостей (crypto ECDH P-256, base64url) — результат совместим с пакетом web-push.
// Вывод вставить в .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); приватный ключ — секрет, не коммитить.
'use strict';

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const publicKey = b64url(ecdh.getPublicKey());   // 65 байт (uncompressed point) → 87 символов
const privateKey = b64url(ecdh.getPrivateKey()); // 32 байта → 43 символа

console.log('# Web Push (VAPID) — добавьте в .env calling_api_v2:');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:support@totus.club');
console.log('# Публичный ключ также нужен сайту (NEXT_PUBLIC_VAPID_PUBLIC_KEY) — он не секрет, отдаётся GET /api/push/vapid-public-key.');
