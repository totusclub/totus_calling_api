'use strict';

/**
 * Кто из клиентов пользователя сейчас «на экране» — для skipIfOnline (сообщения поддержки).
 *
 * Раньше пуш пропускался, если в комнате u:<userId> был ЛЮБОЙ сокет: открытая вкладка сайта,
 * iPhone (сокет звонков VoipService живёт и в фоне) или «зависший» сокет — и тогда закрытый
 * Android не получал ничего (сообщение уходило только в сокет, который он не слушает).
 * Теперь решение принимается по каждому устройству из push_devices:
 *
 *   сокет                                             | что значит                    | FCM телефону      | Web Push
 *   --------------------------------------------------+-------------------------------+-------------------+----------
 *   auth.client='app', presence='foreground', deviceId | приложение на экране (сокет   | не слать ЭТОМУ    | не слать
 *                                                      | чата держится только в active)| устройству        |
 *   auth.client='app' без presence                     | сокет звонков, живёт и в фоне | не влияет         | не влияет
 *   браузер (User-Agent «Mozilla/…»: сайт, desktop)    | вкладка открыта, тост на сайте| не влияет         | не слать
 *   без пометки и не браузер                           | старая версия приложения      | не слать (как было)| не слать
 *
 * Последняя строка сохраняет прежнее поведение для старых сборок (у них баннер в foreground
 * показывается по сокету — пуш дал бы дубль). Без БД и сети — проверяется scripts/check-push-presence.js.
 */

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function isBrowserUserAgent(ua) {
    return typeof ua === 'string' && /\bMozilla\//.test(ua);
}

/** handshake сокета → { kind: 'app-foreground'|'app-background'|'web'|'legacy-app', deviceId? } */
function classifySocket(handshake) {
    const hs = handshake || {};
    const auth = hs.auth && typeof hs.auth === 'object' ? hs.auth : {};
    if (auth.client === 'app') {
        if (auth.presence !== 'foreground') return { kind: 'app-background' };
        const deviceId = typeof auth.deviceId === 'string' && DEVICE_ID_RE.test(auth.deviceId) ? auth.deviceId : null;
        // На экране, но устройство не опознать — осторожно, как раньше (не слать никому из телефонов)
        return deviceId ? { kind: 'app-foreground', deviceId } : { kind: 'legacy-app' };
    }
    const headers = hs.headers && typeof hs.headers === 'object' ? hs.headers : {};
    if (isBrowserUserAgent(headers['user-agent'])) return { kind: 'web' };
    return { kind: 'legacy-app' };
}

/** Сводка по сокетам пользователя. */
function summarize(handshakes) {
    const p = { sockets: 0, web: false, legacyApp: false, foregroundDevices: new Set() };
    for (const hs of handshakes || []) {
        p.sockets += 1;
        const c = classifySocket(hs);
        if (c.kind === 'web') p.web = true;
        else if (c.kind === 'legacy-app') p.legacyApp = true;
        else if (c.kind === 'app-foreground') p.foregroundDevices.add(c.deviceId);
    }
    return p;
}

/** Не слать push на это устройство (строка push_devices), потому что событие видно на экране. */
function shouldSkipDevice(device, presence) {
    if (!presence || !presence.sockets) return false;
    if (presence.legacyApp) return true;
    if (device && device.channel === 'webpush') return presence.web || presence.foregroundDevices.size > 0;
    const id = device && device.device_id ? String(device.device_id) : null;
    return Boolean(id) && presence.foregroundDevices.has(id);
}

module.exports = { classifySocket, summarize, shouldSkipDevice, isBrowserUserAgent };
