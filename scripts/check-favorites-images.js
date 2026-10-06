// Избранное: картинки одной формы для сайта и приложения (lib/favoriteHotel.js + db.js favoriteDb).
// Без БД и сети: node scripts/check-favorites-images.js
//
// Владелец 06.10.2026: отель, добавленный в избранное на сайте, в приложении без изображения.
// Сайт сохранял {webp_x620, x500, …}, приложение рисует только {uri}. Теперь каждая картинка
// получает `uri` при записи и при чтении (старые записи и старые версии приложения тоже).
'use strict';
const assert = require('assert');
const Module = require('module');

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e && e.message ? e.message : e}`); }
}

// db.js без MySQL: фейковый пул
process.env.DB_HOST = process.env.DB_HOST || 'h';
process.env.DB_USER = process.env.DB_USER || 'u';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'p';
process.env.DB_NAME = process.env.DB_NAME || 'd';
const rows = [];
const executed = [];
const fakePool = {
    async execute(sql, args) {
        executed.push([sql, args]);
        if (/^SELECT \* FROM favorites WHERE user_id = \? AND hotel_id = \?/.test(sql)) return [[]];
        if (/^INSERT INTO favorites/.test(sql)) { rows.push({ id: rows.length + 1, hotel_id: args[1], hotel_data: args[2], created_at: new Date() }); return [{ insertId: rows.length }]; }
        if (/^SELECT id, hotel_id, hotel_data, created_at FROM favorites/.test(sql)) return [rows.slice()];
        return [[]];
    },
    async query() { return [[]]; },
    getConnection() { return Promise.resolve({ release() {} }); },
    on() {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'mysql2/promise') return { createPool: () => fakePool };
    if (request === 'dotenv') return { config() {} };
    return origLoad.apply(this, arguments);
};

const { normalizeFavoriteHotelData } = require('../lib/favoriteHotel');
const { favoriteDb } = require('../db');

const webRecord = { id: 77, name: 'Rixos', city_name: 'Анталья', images: [{ webp_x620: 'https://img.cdn.level.travel/webp/a.webp', x500: 'https://img.cdn.level.travel/jpg/a.jpg' }] };
const appRecord = { id: 78, name: 'Delphin', price: '120 000 ₽', images: [{ uri: 'https://img.cdn.level.travel/x/1.jpg' }, { uri: 'https://img.cdn.level.travel/x/2.jpg' }, 12] };

(async () => {
    console.log('Избранное: картинки для сайта и приложения');

    await check('запись сайта получает `uri` (JPEG раньше WebP), поля сайта на месте', () => {
        const n = normalizeFavoriteHotelData(webRecord);
        assert.deepStrictEqual(n.images, [{ webp_x620: 'https://img.cdn.level.travel/webp/a.webp', x500: 'https://img.cdn.level.travel/jpg/a.jpg', uri: 'https://img.cdn.level.travel/jpg/a.jpg' }]);
        assert.strictEqual(n.name, 'Rixos');
        assert.strictEqual(n.city_name, 'Анталья');
    });

    await check('запись приложения: {uri} как были, require-числа убраны, остальные поля не тронуты', () => {
        const n = normalizeFavoriteHotelData(appRecord);
        assert.deepStrictEqual(n.images, [{ uri: 'https://img.cdn.level.travel/x/1.jpg' }, { uri: 'https://img.cdn.level.travel/x/2.jpg' }]);
        assert.strictEqual(n.price, '120 000 ₽');
    });

    await check('строки, «//…», относительные пути LT, поле image, город объектом', () => {
        const n = normalizeFavoriteHotelData({ images: ['//img.cdn.level.travel/a.jpg', 'x620/b.jpg', { x500: '/jpg/c.jpg' }], city: { name_ru: 'Сочи' }, country: { name: 'Россия' } });
        assert.deepStrictEqual(n.images.map((i) => i.uri), ['https://img.cdn.level.travel/a.jpg', 'https://img.cdn.level.travel/x620/b.jpg', 'https://img.cdn.level.travel/jpg/c.jpg']);
        assert.strictEqual(n.images[2].x500, 'https://img.cdn.level.travel/jpg/c.jpg');
        assert.strictEqual(n.city_name, 'Сочи');
        assert.strictEqual(n.country_name, 'Россия');
        assert.deepStrictEqual(normalizeFavoriteHotelData({ image: 'https://cdn/x.jpg' }).images, [{ uri: 'https://cdn/x.jpg', x500: 'https://cdn/x.jpg', webp_x620: 'https://cdn/x.jpg' }]);
        assert.strictEqual(normalizeFavoriteHotelData(null), null);
        assert.deepStrictEqual(normalizeFavoriteHotelData({ name: 'A' }), { name: 'A' }, 'без картинок — без изменений');
    });

    await check('при записи — не больше 20 картинок; при чтении — без ограничения (старые записи как были)', () => {
        const many = { images: Array.from({ length: 40 }, (_, i) => ({ uri: `https://cdn/${i}.jpg` })) };
        assert.strictEqual(normalizeFavoriteHotelData(many, { maxImages: 20 }).images.length, 20);
        assert.strictEqual(normalizeFavoriteHotelData(many).images.length, 40);
    });

    await check('db: добавление с сайта сохраняет `uri`; чтение чинит старую запись сайта и битый JSON', async () => {
        await favoriteDb.addFavorite(5, 77, webRecord);
        const saved = JSON.parse(rows[0].hotel_data);
        assert.strictEqual(saved.images[0].uri, 'https://img.cdn.level.travel/jpg/a.jpg');
        // старая запись (до исправления) — без uri
        rows.push({ id: 2, hotel_id: 79, hotel_data: JSON.stringify({ id: 79, images: [{ webp_x620: 'https://cdn/old.webp', x500: 'https://cdn/old.jpg' }] }), created_at: new Date() });
        rows.push({ id: 3, hotel_id: 80, hotel_data: '{broken', created_at: new Date() });
        const list = await favoriteDb.getUserFavorites(5);
        assert.strictEqual(list.length, 3);
        assert.strictEqual(list[1].hotelData.images[0].uri, 'https://cdn/old.jpg');
        assert.deepStrictEqual(list[2].hotelData, {}, 'одна битая запись не ломает весь список');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
