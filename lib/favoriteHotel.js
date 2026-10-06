'use strict';

/**
 * Избранное: единая форма картинок в hotel_data (таблица favorites) для сайта и приложения.
 *
 * Клиенты присылают hotelData как есть и раньше получали его обратно без изменений:
 *   - сайт (totus_WEB favoriteHotelDisplay) — images: [{webp_x620, x500, …}] без `uri`;
 *   - приложение (totus_APP HotelHeader) — images: [{uri}] или require-число своей сборки.
 * React Native <Image> рисует только {uri} → отель, добавленный на сайте, был в приложении без фото.
 * Здесь каждая картинка получает `uri` (абсолютный https), поля сайта сохраняются, непереносимые
 * значения (числа require) отбрасываются. Применяется при записи и при чтении — так чинятся и
 * старые записи, и старые версии приложения, без миграции.
 */

const LT_CDN = 'https://img.cdn.level.travel/';
const URI_KEYS = ['uri', 'x800x600x', 'x620', 'x500', 'x900', 'webp_x620', 'webp_x900', 'url', 'src', 'image'];
const MAX_IMAGES_ON_SAVE = 20; // при чтении не режем: старые записи приложения показываются как раньше

function resolveImageUrl(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return `https:${s}`;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // data:, file:, … — не адрес CDN
    return LT_CDN + s.replace(/^\/+/, '');
}

function imageUri(image) {
    if (typeof image === 'string') return resolveImageUrl(image);
    if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
    for (const key of URI_KEYS) {
        const url = resolveImageUrl(image[key]);
        if (url) return url;
    }
    for (const v of Object.values(image)) {
        if (typeof v === 'string' && /^(https?:)?\/\//i.test(v)) return resolveImageUrl(v);
    }
    return null;
}

/** Элемент images → объект с `uri` (и прежними полями сайта) или null. */
function normalizeImage(image) {
    const uri = imageUri(image);
    if (!uri) return null;
    if (typeof image === 'string') return { uri, x500: uri, webp_x620: uri };
    const out = { ...image, uri };
    // относительные пути и '//…' в полях сайта — тоже абсолютные
    for (const key of ['webp_x620', 'webp_x900', 'x500', 'x900', 'x620', 'x800x600x']) {
        if (typeof out[key] === 'string') {
            const url = resolveImageUrl(out[key]);
            if (url) out[key] = url;
            else delete out[key];
        }
    }
    return out;
}

function nameOf(v) {
    if (typeof v === 'string') return v.trim() || null;
    if (v && typeof v === 'object') return nameOf(v.name_ru) || nameOf(v.name) || null;
    return null;
}

/**
 * hotel_data → та же запись, но картинки с `uri`, город/страна строкой (если были объектом).
 * opts.maxImages — ограничение числа картинок (при записи).
 */
function normalizeFavoriteHotelData(hotelData, opts = {}) {
    const maxImages = Number.isFinite(opts.maxImages) ? opts.maxImages : Infinity;
    if (!hotelData || typeof hotelData !== 'object' || Array.isArray(hotelData)) return hotelData;
    const out = { ...hotelData };
    const raw = Array.isArray(hotelData.images) ? hotelData.images : [];
    const images = [];
    const seen = new Set();
    for (const img of raw) {
        const n = normalizeImage(img);
        if (n && !seen.has(n.uri)) {
            seen.add(n.uri);
            images.push(n);
        }
        if (images.length >= maxImages) break;
    }
    if (!images.length) {
        for (const key of ['image', 'photo', 'cover', 'thumbnail']) {
            const n = normalizeImage(hotelData[key]);
            if (n) {
                images.push(n);
                break;
            }
        }
    }
    if (Array.isArray(hotelData.images) || images.length) out.images = images;
    if (!out.city_name) {
        const city = nameOf(hotelData.city);
        if (city) out.city_name = city;
    }
    if (!out.country_name) {
        const country = nameOf(hotelData.country);
        if (country) out.country_name = country;
    }
    return out;
}

module.exports = { normalizeFavoriteHotelData, resolveImageUrl, imageUri, MAX_IMAGES_ON_SAVE };
