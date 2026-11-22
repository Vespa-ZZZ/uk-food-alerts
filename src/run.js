import { fingerprint, matches, PAGE_SIZE, pageUrl, parsePage, retryAfterMs, validateInput } from './fsa.js';

const INTERVAL_MS = 2350;
const MAX_RETRIES = 3;
const MAX_PAGES = 100;
const STATE_STORE = 'uk-food-alerts-state';
const USER_AGENT = 'uk-food-alerts-actor/1.0';

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>')
        .split(/\r?\n/, 1)[0];
}

async function fetchPage(url, offset, { fetch, sleep, log, now }) {
    let wait = 0;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (wait) await sleep(wait);
        let response;
        let body;
        try {
            response = await fetch(url, {
                headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
                redirect: 'manual',
                signal: AbortSignal.timeout(15_000),
            });
            if (response.ok) body = await response.text();
            else await response.body?.cancel().catch(() => {});
        } catch {
            response = undefined;
        }

        if (response?.ok) {
            let data;
            try {
                data = JSON.parse(body);
            } catch {
                throw new Error('Unrecognized FSA Food Alerts response: expected a JSON list.');
            }
            return parsePage(data, offset);
        }

        const status = response?.status;
        const reason = status === undefined ? 'a network error or timeout' : 'HTTP ' + status;
        const retryable = status === undefined || status === 429 || (status >= 500 && status < 600);
        if (!retryable || attempt === MAX_RETRIES) throw new Error('FSA Food Alerts API returned ' + reason + '.');

        wait = Math.max(INTERVAL_MS * 2 ** attempt, retryAfterMs(response?.headers.get('retry-after'), now()));
        if (wait > 2_147_483_647) throw new Error('FSA requested a retry delay beyond this run. Try again later.');
        log.warning('FSA request failed with ' + reason + '. Retrying in ' + Math.ceil(wait / 1000) + ' seconds.');
    }
}

export async function runActor({
    actor,
    log,
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
}) {
    const input = validateInput((await actor.getInput()) ?? {}, now());
    const summary = { pages: 0, fetched: 0, matched: 0, skippedSeen: 0, pushed: 0, chargeLimitReached: false };
    const candidates = [];
    const notations = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0) await sleep(INTERVAL_MS);
        const offset = page * PAGE_SIZE;
        const entries = await fetchPage(pageUrl(input, offset), offset, { fetch, sleep, log, now });
        summary.pages++;
        summary.fetched += entries.length;

        for (const entry of entries) {
            const notation = entry.record.notation.toUpperCase();
            if (notations.has(notation)) {
                throw new Error('FSA returned a duplicate alert across the result list. Retry the run.');
            }
            notations.add(notation);
            if (matches(entry, input)) candidates.push(entry.record);
        }

        if (entries.length < PAGE_SIZE) break;
        if (page === MAX_PAGES - 1) throw new Error('FSA page limit reached. Choose a narrower date range or fewer alert types.');
    }

    summary.matched = candidates.length;
    candidates.sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified) || a.notation.localeCompare(b.notation));
    const store = input.onlyNew ? await actor.openKeyValueStore(STATE_STORE) : null;
    const key = 'seen-' + input.stateKey;
    const saved = store ? (await store.getValue(key)) ?? [] : [];
    if (!Array.isArray(saved) || saved.some((version) => typeof version !== 'string')) {
        throw new Error('Unrecognized monitoring state. Use a different stateKey to start fresh.');
    }
    const seen = new Set(saved);

    for (const record of candidates) {
        const version = fingerprint(record);
        if (seen.has(version)) {
            summary.skippedSeen++;
            continue;
        }

        // A single-row push keeps chargedCount unambiguous when the PPE limit is reached.
        // Free/local pushes can return chargedCount: 0 without reaching a limit.
        const result = await actor.pushData(record);
        summary.chargeLimitReached = result?.eventChargeLimitReached === true;
        if (!summary.chargeLimitReached || result.chargedCount > 0) {
            summary.pushed++;
            if (store) {
                seen.add(version);
                await store.setValue(key, [...seen]);
            }
        }
        if (summary.chargeLimitReached) {
            log.warning('Pay-per-event limit reached. Versions that were not saved remain eligible for the next run.');
            break;
        }
    }

    await actor.setValue('RUN_SUMMARY', summary);
    log.info('Saved ' + summary.pushed + ' alerts from ' + summary.pages + ' FSA page(s).');
    return summary;
}
