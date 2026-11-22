export const ALERT_TYPES = ['AA', 'PRIN', 'FAFA'];
export const ENDPOINT = 'https://data.food.gov.uk/food-alerts/id.json';
export const PAGE_SIZE = 100;

const DATA_ORIGIN = 'data.food.gov.uk';
const LICENCE = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
const SOURCE = {
    publisher: 'Food Standards Agency',
    url: ENDPOINT,
    license: 'OGL v3.0',
    licenseUrl: LICENCE,
    attribution: 'Contains public sector information from the Food Standards Agency licensed under the Open Government Licence v3.0.',
};
const DAY_MS = 86_400_000;
const NOTATION = /^FSA-(AA|PRIN|FAFA)-\d+-\d{4}(?:-update-\d+)?$/i;
const ALERT_PAGE = /^https?:\/\/((?:alerts|www)\.food\.gov\.uk)\/news-alerts\/alert\/([a-z0-9_-]+)\/?$/i;
const EMAIL_ADDRESS = /[\p{L}\p{N}._%+-]+[@＠](?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}/giu;
// UK national numbers and international numbers with a + or 00 prefix.
const PHONE_NUMBER = /(?<![\p{L}\p{N}+])(?:(?:\+|00)\d{1,3}(?:[ \t\u00a0\u202f().-]*\d){7,12}|\(?0(?:[ \t\u00a0\u202f().-]*\d){9,10})(?![\p{L}\p{N}])/gu;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
const unique = (values) => [...new Set(values.filter(Boolean))];
const lower = (value) => value.toLowerCase();

function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function stringList(input, key) {
    const values = input[key] === undefined ? [] : input[key];
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value.trim())) {
        throw new Error(key + ' must be an array of nonempty strings.');
    }
    return unique(values.map((value) => value.trim()));
}

export function validateInput(input, now = Date.now()) {
    if (!object(input)) throw new Error('Input must be a JSON object.');
    const alertTypes = stringList(input, 'alertTypes');
    if (alertTypes.some((type) => !ALERT_TYPES.includes(type))) {
        throw new Error('alertTypes accepts AA, PRIN and FAFA.');
    }
    const { since, daysBack = 30, onlyNew = false, stateKey = 'default' } = input;
    if (since !== undefined && !isDate(since)) throw new Error('since must be a valid YYYY-MM-DD date.');
    if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 36500) {
        throw new Error('daysBack must be an integer between 1 and 36500.');
    }
    if (typeof onlyNew !== 'boolean') throw new Error('onlyNew must be a boolean.');
    if (typeof stateKey !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(stateKey)) {
        throw new Error('stateKey must contain 1 to 50 letters, digits, underscores or hyphens.');
    }
    return {
        alertTypes: alertTypes.length ? alertTypes : ALERT_TYPES,
        allergens: stringList(input, 'allergens').map(lower),
        keywords: stringList(input, 'keywords').map(lower),
        cutoff: since === undefined ? now - daysBack * DAY_MS : Date.parse(since),
        onlyNew,
        stateKey,
    };
}

export function pageUrl(input, offset) {
    const url = new URL(ENDPOINT);
    // The API implements the strict min- filter for modified; include the boundary and filter locally.
    url.searchParams.set('min-modified', new Date(input.cutoff - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    url.searchParams.set('_view', 'full');
    url.searchParams.set('_sort', 'notation');
    url.searchParams.set('_limit', PAGE_SIZE);
    url.searchParams.set('_offset', offset);
    if (input.alertTypes.length < ALERT_TYPES.length) {
        for (const type of input.alertTypes) url.searchParams.append('type', type);
    }
    return url;
}

function badSchema(field) {
    throw new Error('Unrecognized FSA Food Alerts response at ' + field + '.');
}

function objects(value, field) {
    const values = list(value);
    if (values.some((entry) => !object(entry))) badSchema(field);
    return values;
}

function plain(value) {
    if (typeof value !== 'string') return null;
    return value.trim().replace(/\s+/g, ' ') || null;
}

function redactContacts(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    return value.replace(EMAIL_ADDRESS, '[redacted]').replace(PHONE_NUMBER, '[redacted]');
}

function conceptValues(value) {
    return unique(list(value).map((text) => redactContacts(plain(text))));
}

function codeAt(value, host, path) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^https?:\/\/([^/]+)(\/[^?#]+)$/i);
    if (!match || lower(match[1]) !== host || !match[2].startsWith(path)) return null;
    const code = match[2].slice(path.length);
    return /^[a-z0-9_-]+$/i.test(code) ? code : null;
}

function alertPageUrl(value, notation) {
    const url = object(value) ? value['@id'] : value;
    const match = typeof url === 'string' ? url.match(ALERT_PAGE) : null;
    if (!match || lower(match[2]) !== lower(notation)) return null;
    return 'https://' + lower(match[1]) + '/news-alerts/alert/' + match[2];
}

function allergenDetails(value) {
    return objects(value, 'allergen').map((allergen) => {
        const labels = unique([...conceptValues(allergen.label), ...conceptValues(allergen.prefLabel)]);
        const codes = conceptValues(allergen.notation);
        const code = codeAt(allergen['@id'], DATA_ORIGIN, '/codes/alerts/def/allergen/');
        if (code) codes.push(code);
        if (!labels.length && !codes.length) badSchema('allergen label or notation');
        return { label: labels[0] ?? codes[0], terms: [...labels, ...codes, ...conceptValues(allergen.altLabel)] };
    });
}

function normalizeProduct(product) {
    const text = (value) => redactContacts(plain(value));
    const batches = objects(product.batchDescription, 'productDetails.batchDescription')
        .map((batch) => ({
            batchCode: text(batch.batchCode),
            lotNumber: text(batch.lotNumber),
            bestBeforeDate: text(batch.bestBeforeDate),
            bestBeforeDescription: text(batch.bestBeforeDescription),
            useByDate: text(batch.useByDate),
            useByDescription: text(batch.useByDescription),
        }))
        .filter((batch) => Object.values(batch).some(Boolean));
    return {
        name: text(product.productName),
        packSize: text(product.packSizeDescription),
        batches: batches.length ? batches : null,
    };
}

function normalizeAlert(raw) {
    if (!object(raw) || typeof raw.notation !== 'string') badSchema('items[].notation');
    const notationType = raw.notation.match(NOTATION)?.[1].toUpperCase();
    const typeCodes = list(raw.type).map((type) => codeAt(type, DATA_ORIGIN, '/food-alerts/def/'));
    const types = typeCodes.filter((type) => ALERT_TYPES.includes(type));
    const idCode = codeAt(raw['@id'], DATA_ORIGIN, '/food-alerts/id/');
    if (!notationType || !idCode || lower(idCode) !== lower(raw.notation)) badSchema('items[].@id or notation');
    if (types.length !== 1 || types[0] !== notationType) badSchema('items[].type');
    const title = redactContacts(raw.title);
    if (!title) badSchema('items[].title');
    const { created, modified } = raw;
    if (!isDate(created)) badSchema('items[].created');
    if (typeof modified !== 'string' || !isDate(modified.slice(0, 10)) ||
        !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(modified) ||
        !Number.isFinite(Date.parse(modified))) badSchema('items[].modified');

    let status = null;
    if (raw.status != null) {
        if (!object(raw.status)) badSchema('items[].status');
        const code = codeAt(raw.status['@id'], DATA_ORIGIN, '/codes/alerts/def/status/');
        status = conceptValues(raw.status.label)[0] ?? code ?? null;
        if (!status) badSchema('items[].status label or code');
    }

    const businessEntries = [
        ...objects(raw.reportingBusiness, 'reportingBusiness'),
        ...objects(raw.otherBusiness, 'otherBusiness'),
    ];
    const businesses = unique(businessEntries.map((business) => redactContacts(business.commonName)));
    const problems = objects(raw.problem, 'problem');
    const productDetails = objects(raw.productDetails, 'productDetails');
    const allergenInfo = [...problems, ...productDetails].flatMap((entry) => allergenDetails(entry.allergen));
    const riskStatements = unique(problems.map((problem) => redactContacts(problem.riskStatement)));
    const countries = unique(objects(raw.country, 'country').flatMap((country) => conceptValues(country.label)));
    const products = productDetails.map(normalizeProduct)
        .filter((product) => Object.values(product).some(Boolean));
    return {
        allergenTerms: new Set(allergenInfo.flatMap(({ terms }) => terms.map(lower))),
        record: {
            id: 'https://' + DATA_ORIGIN + '/food-alerts/id/' + idCode,
            notation: raw.notation,
            type: types[0],
            title,
            created,
            modified,
            status,
            problem: riskStatements.length ? riskStatements : null,
            allergens: unique(allergenInfo.map(({ label }) => label)),
            products: products.length ? products : null,
            businesses: businesses.length ? businesses : null,
            country: countries.length ? countries : null,
            alertUrl: alertPageUrl(raw.alertURL, raw.notation),
            source: SOURCE,
        },
    };
}

export function parsePage(data, offset) {
    if (!object(data) || !object(data.meta) || !Array.isArray(data.items)) badSchema('meta or items');
    const { meta, items } = data;
    if (meta.publisher !== SOURCE.publisher || typeof meta.license !== 'string' ||
        meta.license.replace(/^http:/, 'https:').replace(/\/?$/, '/') !== LICENCE) badSchema('meta.publisher or meta.license');
    if (meta.limit !== PAGE_SIZE || items.length > PAGE_SIZE || (meta.offset ?? 0) !== offset) {
        badSchema('meta pagination');
    }
    return items.map(normalizeAlert);
}

export function matches({ record, allergenTerms }, input) {
    return input.alertTypes.includes(record.type) &&
        Date.parse(record.modified) >= input.cutoff &&
        (!input.allergens.length || input.allergens.some((term) => allergenTerms.has(term))) &&
        (!input.keywords.length || input.keywords.some((term) => record.title?.toLowerCase().includes(term)));
}

export function fingerprint(record) {
    return JSON.stringify([record.notation, record.modified, record.status?.toLowerCase() ?? null]);
}

export function retryAfterMs(value, now) {
    if (!value) return 0;
    const duration = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    return Number.isNaN(duration) ? 0 : Math.max(0, duration);
}
