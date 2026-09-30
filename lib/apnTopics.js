'use strict';

/**
 * VoIP-пуши iOS для нескольких приложений (Totus Club + Totus Support) без изменения index.js.
 *
 * APNs принимает VoIP-пуш только с topic = "<bundle id приложения>.voip". index.js шлёт все
 * VoIP-пуши с одним topic из APN_VOIP_TOPIC (клиентское приложение, app.totus.club.voip).
 * Токен приложения поддержки (club.totus.support) с этим topic APNs отклоняет:
 * 400 DeviceTokenNotForTopic.
 *
 * Модуль оборачивает apn.Provider.prototype.send: если VoIP-пуш не прошёл с причиной
 * DeviceTokenNotForTopic / TopicDisallowed, он повторяется с topic из APN_VOIP_TOPIC_ALT
 * (через запятую, по умолчанию club.totus.support.voip). Успешный topic запоминается для
 * токена в памяти — следующие звонки на это устройство идут сразу с правильным topic.
 *
 * Поведение для клиентского приложения не меняется: его пуши проходят с первой попытки.
 * Отключить: APN_VOIP_TOPIC_ALT=off.
 */

const RETRY_REASONS = new Set(['DeviceTokenNotForTopic', 'TopicDisallowed']);
const tokenTopic = new Map(); // voipToken -> topic, который APNs принял
const TOKEN_TOPIC_MAX = 5000;

function altTopics() {
    const raw = process.env.APN_VOIP_TOPIC_ALT;
    if (raw && raw.trim().toLowerCase() === 'off') return [];
    return String(raw || 'club.totus.support.voip')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function remember(token, topic) {
    if (tokenTopic.size >= TOKEN_TOPIC_MAX) tokenTopic.delete(tokenTopic.keys().next().value);
    tokenTopic.set(token, topic);
}

function reasonOf(failure) {
    return (failure && failure.response && failure.response.reason) || null;
}

function install(apn) {
    if (!apn || !apn.Provider || apn.Provider.prototype.__totusTopicPatched) return;
    const originalSend = apn.Provider.prototype.send;

    apn.Provider.prototype.send = async function patchedSend(notification, recipients) {
        const isVoip = notification && notification.pushType === 'voip';
        const list = Array.isArray(recipients) ? recipients : [recipients];
        if (!isVoip || list.length !== 1 || typeof list[0] !== 'string') {
            return originalSend.call(this, notification, recipients);
        }

        const token = list[0];
        const baseTopic = notification.topic;
        const known = tokenTopic.get(token);
        if (known && known !== baseTopic) notification.topic = known;

        let result = await originalSend.call(this, notification, recipients);
        const failed = (result && result.failed) || [];
        if (!failed.length) {
            if (notification.topic) remember(token, notification.topic);
            notification.topic = baseTopic;
            return result;
        }
        if (!RETRY_REASONS.has(reasonOf(failed[0]))) {
            notification.topic = baseTopic;
            return result;
        }

        const tried = new Set([notification.topic]);
        const candidates = [baseTopic, ...altTopics()].filter((t) => t && !tried.has(t));
        for (const topic of candidates) {
            notification.topic = topic;
            const retry = await originalSend.call(this, notification, recipients);
            if (retry && retry.sent && retry.sent.length) {
                remember(token, topic);
                console.log(`[apn] VoIP push delivered with topic ${topic} (after ${reasonOf(failed[0])})`);
                result = retry;
                break;
            }
            const r = retry && retry.failed && retry.failed[0];
            if (!RETRY_REASONS.has(reasonOf(r))) {
                result = retry;
                break;
            }
        }
        notification.topic = baseTopic;
        return result;
    };
    apn.Provider.prototype.__totusTopicPatched = true;
    console.log(`[apn] multi-topic VoIP enabled (alt: ${altTopics().join(', ') || 'off'})`);
}

try {
    install(require('apn'));
} catch (e) {
    console.warn('[apn] multi-topic patch not installed:', e.message);
}

module.exports = { install, _internal: { tokenTopic, altTopics, RETRY_REASONS } };
