import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { matches, PAGE_SIZE, pageUrl, parsePage, validateInput } from '../src/fsa.js';
import { runActor, sanitize } from '../src/run.js';

function fixture(name) {
    return JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url)));
}

const aaPrin = fixture('aa-prin');
const fafa = fixture('fafa').items[0];
const [withdrawn] = fixture('withdrawn').items;
const [aa, multiLot, prin, followUp] = aaPrin.items;
const now = () => Date.parse('2026-11-22T00:00:00Z');
const historical = { since: '2018-01-01' };

function page(items, offset = 0) {
    return { meta: { ...aaPrin.meta, limit: PAGE_SIZE, ...(offset ? { offset } : {}) }, items };
}

function mockActor(input, state = new Map(), save = () => ({ chargedCount: 0, eventChargeLimitReached: false })) {
    const rows = [];
    let summary;
    const actor = {
        getInput: async () => input,
        async openKeyValueStore(name) {
            assert.equal(name, 'uk-food-alerts-state');
            return {
                getValue: async (key) => state.get(key),
                setValue: async (key, value) => state.set(key, structuredClone(value)),
            };
        },
        async pushData(row) {
            const result = save(row, rows.length);
            if (!result?.eventChargeLimitReached || result.chargedCount > 0) rows.push(row);
            return result;
        },
        async setValue(key, value) {
            assert.equal(key, 'RUN_SUMMARY');
            summary = value;
        },
    };
    return { actor, rows, summary: () => summary };
}

const log = { warning() {}, info() {} };
const noSleep = async () => {};
const response = (items, offset) => Response.json(page(items, offset));

async function monitor(items, state, save, stateKey = 'stock') {
    const mock = mockActor({ ...historical, onlyNew: true, stateKey }, state, save);
    await runActor({ actor: mock.actor, fetch: async () => response(items), sleep: noSleep, now, log });
    return mock.rows;
}

test('normalizes AA, PRIN, FAFA, a follow-up and an actual withdrawal', () => {
    const entries = parsePage(page([aa, multiLot, prin, fafa, followUp, withdrawn]), 0);
    const [allergy, lots, recall, action, update, withdrawal] = entries.map((entry) => entry.record);
    assert.deepEqual(allergy.allergens, ['Milk']);
    assert.deepEqual(allergy.businesses, ['Community Foods']);
    assert.equal(allergy.country, null);
    assert.equal(allergy.source.license, 'OGL v3.0');
    assert.match(allergy.source.attribution, /Food Standards Agency/);
    assert.match(allergy.id, /^https:\/\/data\.food\.gov\.uk\//);
    assert.equal(allergy.alertUrl, aa.alertURL);
    assert.match(allergy.problem[0], /milk/);
    assert.equal(allergy.type, 'AA');
    assert.equal(recall.type, 'PRIN');
    assert.equal(action.type, 'FAFA');
    assert.equal(withdrawal.status, 'Withdrawn');
    assert.notEqual(update.notation, recall.notation);
    assert.match(update.notation, /update-01$/i);
    assert.deepEqual(recall.country, ['England', 'Northern Ireland']);
    assert.deepEqual(recall.products[0].batches.map((batch) => batch.useByDate), ['2018-03-01', '2018-03-02', '2018-03-03']);
    assert.deepEqual(lots.products[0].batches.map((batch) => [batch.lotNumber, batch.bestBeforeDate]), [
        ['200676', '2019-10-30'], ['200676', '2019-11-01'], ['200953', '2019-11-06'],
    ]);
    assert.equal(lots.products[0].batches[0].useByDate, null);
    assert.equal(action.products[0].batches[0].batchCode, 'All batch codes');
});

test('matches exact allergen codes and labels, title substrings, and the inclusive modified boundary', () => {
    const altered = structuredClone(aa);
    altered.modified = '2018-03-01T00:00:00.000Z';
    altered.problem[0].allergen[0].notation = 'test-notation';
    const [entry] = parsePage(page([altered]), 0);
    const filter = (overrides) => validateInput({
        since: '2018-03-01', daysBack: 1, alertTypes: ['AA'], keywords: ['no match', 'GROUND RICE'],
        ...overrides,
    }, now());
    assert.equal(matches(entry, filter({ allergens: ['test-notation'] })), true);
    assert.equal(matches(entry, filter({ allergens: ['mILk'] })), true);
    assert.equal(matches(entry, filter({ allergens: ['mil'] })), false);
    assert.equal(matches(entry, filter({ since: '2018-03-02' })), false);
    assert.equal(matches(entry, filter({ alertTypes: ['FAFA'] })), false);
    assert.equal(matches(entry, filter({ keywords: ['milk powder'] })), false);
    assert.deepEqual(pageUrl(filter({ alertTypes: ['AA', 'PRIN'] }), 100).searchParams.getAll('type'), ['AA', 'PRIN']);
    assert.equal(pageUrl(filter({}), 0).searchParams.get('min-modified'), '2018-02-28T23:59:59Z');
    assert.equal(validateInput({}, now()).cutoff, Date.parse('2026-10-23T00:00:00Z'));
});

test('keeps FSA titles, business names and risk statements while redacting embedded contact details', () => {
    const item = {
        ...aa,
        title: 'Healthy Fit recalls Dr. Oat bars. Call 07700 900123.',
        reportingBusiness: { commonName: 'Healthy Fit', contact: 'contact@example.invalid' },
        otherBusiness: [
            { commonName: 'Healthy Fit' },
            { commonName: 'Dr. Oat (support+recall@example.invalid)', phone: '07700 900124' },
        ],
        consumerAdvice: 'Contact the retailer.',
        problem: [
            { riskStatement: 'Risk from contact with milk.\nSee https://www.food.gov.uk/ for advice.' },
            { riskStatement: 'Email recall@example.invalid or call +44 (0)20 7946 0958 / (020) 7946 0959.' },
        ],
        productDetails: [{ productName: 'Dr. Oat bars', batchDescription: [{ batchCode: 'Lot A' }] }],
    };
    const [{ record }] = parsePage(page([item]), 0);
    assert.equal(record.title, 'Healthy Fit recalls Dr. Oat bars. Call [redacted].');
    assert.deepEqual(record.businesses, ['Healthy Fit', 'Dr. Oat ([redacted])']);
    assert.deepEqual(record.problem, [item.problem[0].riskStatement, 'Email [redacted] or call [redacted] / [redacted].']);
    assert.equal(record.products[0].name, 'Dr. Oat bars');
    assert.doesNotMatch(JSON.stringify(record), /example\.invalid|07700|7946|consumerAdvice/);
});

test('returns verified FSA notice URLs from both hosts, including follow-ups', () => {
    const current = 'https://alerts.food.gov.uk/news-alerts/alert/fsa-prin-10-2018-update-01';
    const [legacy, update] = parsePage(page([aa, { ...followUp, alertURL: { '@id': current } }]), 0);
    assert.equal(legacy.record.alertUrl, aa.alertURL);
    assert.equal(update.record.alertUrl, current);

    for (const alertURL of [undefined, current, aa.alertURL + '?contact=private',
        aa.alertURL.replace('www.food.gov.uk', 'www.food.gov.uk.example.invalid'),
        aa.alertURL.replace('www.food.gov.uk', 'untrusted@alerts.food.gov.uk')]) {
        const [{ record }] = parsePage(page([{ ...aa, alertURL }]), 0);
        assert.equal(record.alertUrl, null);
    }
});

test('rejects malformed input and changed upstream fields without treating them as empty results', async () => {
    for (const input of [{ since: '2025-02-29' }, { keywords: 'milk' }, { onlyNew: 'true' },
        { daysBack: -1 }, { alertTypes: ['foo'] }, { stateKey: 'a/b' }]) {
        assert.throws(() => validateInput(input, now()));
    }
    assert.deepEqual(parsePage(page([]), 0), []);
    assert.throws(() => parsePage({ meta: {}, items: [] }, 0), /meta\.publisher or meta\.license/);
    assert.throws(() => parsePage(page([aa]), PAGE_SIZE), /meta pagination/);
    assert.throws(() => parsePage(page([{ ...aa, type: ['different-shape'] }]), 0), /items\[\]\.type/);
    assert.throws(() => parsePage(page([{ ...aa, productDetails: { batchDescription: 'changed' } }]), 0), /batchDescription/);
    const { actor } = mockActor(historical);
    await assert.rejects(runActor({ actor, fetch: async () => new Response('<html>'), sleep: noSleep, now, log }), /expected a JSON list/);
    const samplePath = ['', 'home', 'example-id', 'item'].join('/');
    assert.equal(sanitize('failed at ' + samplePath + '\nstack'), 'failed at <path>');
});

test('paginates sequentially and rejects a repeated page before any writes', async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) => {
        const notation = 'FSA-AA-' + (index + 100) + '-2018';
        return { ...aa, notation, '@id': 'http://data.food.gov.uk/food-alerts/id/' + notation };
    });
    const { actor, rows, summary } = mockActor(historical);
    const actions = [];
    const deps = {
        actor, now, log, sleep: async (delay) => actions.push(delay),
        fetch: async (url) => {
            const offset = Number(url.searchParams.get('_offset'));
            actions.push('offset=' + offset);
            return offset ? response([prin], offset) : response(firstPage);
        },
    };
    await runActor(deps);
    assert.deepEqual(actions, ['offset=0', 2350, 'offset=100']);
    assert.equal(rows.length, 101);
    assert.equal(summary().pages, 2);

    const duplicate = mockActor(historical);
    await assert.rejects(runActor({
        ...deps, actor: duplicate.actor, fetch: async (url) => {
            const offset = Number(url.searchParams.get('_offset'));
            return offset ? response([firstPage[0]], offset) : response(firstPage);
        },
    }), /duplicate alert/);
    assert.equal(duplicate.rows.length, 0);
});

test('retries network errors, 429 and 5xx up to three times, honoring Retry-After', async () => {
    const { actor } = mockActor(historical);
    const delays = [];
    let calls = 0;
    const fetch = async () => {
        calls++;
        if (calls === 1) throw new Error('socket closed');
        if (calls === 2) return new Response(null, { status: 429, headers: { 'Retry-After': '7' } });
        if (calls === 3) return new Response(null, { status: 503, headers: { 'Retry-After': 'Sun, 22 Nov 2026 00:00:12 GMT' } });
        return response([]);
    };
    await runActor({ actor, fetch, sleep: async (delay) => delays.push(delay), now, log });
    assert.deepEqual(delays, [2350, 7000, 12000]);
    assert.equal(calls, 4);

    for (const [status, attempts] of [[403, 1], [503, 4]]) {
        calls = 0;
        await assert.rejects(runActor({
            actor, fetch: async () => { calls++; return new Response(null, { status }); }, sleep: noSleep, now, log,
        }), new RegExp('HTTP ' + status));
        assert.equal(calls, attempts);
    }
});

test('monitors independent keys and detects timestamp revisions and status-only withdrawals', async () => {
    const state = new Map();
    assert.equal((await monitor([aa], state)).length, 1);
    assert.deepEqual(await monitor([aa], state), []);
    const revision = { ...aa, modified: '2018-03-04T00:00:00Z' };
    assert.equal((await monitor([revision], state)).length, 1);
    const withdrawal = { ...revision, status: withdrawn.status };
    assert.equal((await monitor([withdrawal], state))[0].status, 'Withdrawn');
    assert.deepEqual(await monitor([withdrawal], state), []);
    assert.deepEqual(await monitor([aa], state), []);
    assert.equal((await monitor([withdrawal], state, undefined, 'another')).length, 1);
});

test('records only rows saved before or at the PPE limit and retries rejected rows', async () => {
    for (const chargedCount of [0, 1]) {
        const state = new Map();
        const originals = [aa, prin, fafa];
        const first = await monitor(originals, state, (_, savedCount) => savedCount === 0
            ? { chargedCount: 1, eventChargeLimitReached: false }
            : { chargedCount, eventChargeLimitReached: true });
        assert.equal(first.length, 1 + chargedCount);
        assert.equal(state.get('seen-stock').length, first.length);
        const remaining = await monitor(originals, state, () => undefined);
        assert.equal(remaining.length, 2 - chargedCount);
        assert.equal(new Set([...first, ...remaining].map((row) => row.notation)).size, 3);
        assert.deepEqual(await monitor(originals, state), []);
    }
});

test('keeps a successful push in state if the next dataset write fails', async () => {
    const state = new Map();
    await assert.rejects(monitor([aa, prin], state, (_, savedCount) => {
        if (savedCount) throw new Error('dataset write failed');
        return undefined;
    }), /dataset write failed/);
    assert.equal(state.get('seen-stock').length, 1);
    assert.equal((await monitor([aa, prin], state)).length, 1);
});
