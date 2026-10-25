const { createAutotaskAuthProvider } = require('./autotaskAuth');
const { readBoundedResponseText } = require('./boundedHttpBody');
const { parseCanonicalProviderId } = require('./providerIds');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_RECORDS = 2000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const RESPONSE_BYTES = Symbol('autotaskResponseBytes');

class AutotaskError extends Error {
    constructor(statusCode, message, code, details = {}) {
        super(message);
        this.statusCode = statusCode;
        this.details = Object.assign({ code }, details);
    }
}

function createAutotaskClient(options = {}) {
    const env = options.env || process.env;
    const fetchImpl = options.fetch || globalThis.fetch;
    const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 30000);
    const maxPages = positiveInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 50);
    const maxRecords = positiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS, 1, 10000);
    const auth = options.authProvider || createAutotaskAuthProvider({ env, fetch: fetchImpl, timeoutMs });

    function status() {
        return auth.status();
    }

    async function health() {
        const result = await query('Tickets', [{ op: 'gte', field: 'id', value: 1 }], {
            fields: ['id'],
            maxRecords: 1,
            maxPages: 1
        });
        return {
            connected: true,
            provider: 'autotask',
            mode: status().mode,
            checkedAt: new Date().toISOString(),
            queryVerified: Array.isArray(result.items)
        };
    }

    async function query(entity, filter, queryOptions = {}) {
        const safeEntity = requireEntity(entity);
        const body = { filter: normaliseFilter(filter) };
        const fields = normaliseFields(queryOptions.fields);
        if (fields.length) body.includeFields = fields;
        const configuredPages = positiveInteger(queryOptions.maxPages, maxPages, 1, maxPages);
        const configuredRecords = positiveInteger(queryOptions.maxRecords, maxRecords, 1, maxRecords);
        let next = `/${safeEntity}/query`;
        let method = 'POST';
        let requestBody = body;
        let pages = 0;
        let truncated = false;
        const items = [];
        const seen = new Set();
        let responseBytes = 0;
        while (next && pages < configuredPages && items.length < configuredRecords) {
            const target = await buildApiUrl(auth, next);
            if (seen.has(target)) {
                throw new AutotaskError(502, 'Autotask returned a repeated pagination URL', 'autotask_pagination_invalid');
            }
            seen.add(target);
            const payload = await request(target, { method, body: requestBody, mutation: false });
            responseBytes += Number(payload && payload[RESPONSE_BYTES] || 0);
            if (responseBytes > MAX_RESPONSE_BYTES) {
                throw new AutotaskError(502, 'Autotask returned more paginated data than No Fries accepts', 'autotask_response_too_large');
            }
            const page = extractQueryPage(payload);
            const pageItems = page.items;
            const remaining = configuredRecords - items.length;
            items.push(...pageItems.slice(0, remaining));
            if (pageItems.length > remaining) truncated = true;
            pages += 1;
            next = page.next;
            method = 'GET';
            requestBody = undefined;
        }
        if (next) truncated = true;
        return { items, pages, truncated };
    }

    async function get(entity, id) {
        const safeEntity = requireEntity(entity);
        const safeId = requireNumericId(id, `${safeEntity.toLowerCase()}_id_invalid`);
        const payload = await request(await buildApiUrl(auth, `/${safeEntity}/${safeId}`), {
            method: 'GET',
            mutation: false
        });
        return extractItem(payload);
    }

    async function create(entity, payload) {
        assertWriteEnabled();
        const safeEntity = requireEntity(entity);
        const result = await request(await buildApiUrl(auth, `/${safeEntity}`), {
            method: 'POST',
            body: requireObject(payload),
            mutation: true
        });
        return normaliseMutationResult(result);
    }

    async function update(entity, id, payload) {
        assertWriteEnabled();
        const safeEntity = requireEntity(entity);
        const safeId = requireNumericId(id, `${safeEntity.toLowerCase()}_id_invalid`);
        const body = requireObject(payload);
        if (String(body.id == null ? '' : body.id) !== safeId) {
            throw new AutotaskError(400, 'The Autotask update identity is ambiguous', 'autotask_update_id_mismatch');
        }
        const result = await request(await buildApiUrl(auth, `/${safeEntity}`), {
            method: 'PATCH',
            body,
            mutation: true
        });
        return normaliseMutationResult(result);
    }

    async function request(url, options = {}) {
        if (typeof fetchImpl !== 'function') {
            throw new AutotaskError(503, 'The Autotask HTTP client is unavailable', 'autotask_http_unavailable');
        }
        const method = String(options.method || 'GET').toUpperCase();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                method,
                headers: Object.assign({
                    Accept: 'application/json',
                    'Content-Type': 'application/json; charset=utf-8',
                    'User-Agent': 'NoFries-Autotask/1.0'
                }, auth.requestHeaders()),
                body: options.body == null ? undefined : JSON.stringify(options.body),
                redirect: 'error',
                signal: controller.signal
            });
            const text = await boundedResponseText(response);
            if (!response.ok) {
                throw providerHttpError(response.status, options.mutation === true);
            }
            let payload = {};
            if (text) {
                try {
                    payload = JSON.parse(text);
                } catch (error) {
                    throw new AutotaskError(502, 'Autotask returned invalid JSON', 'autotask_response_invalid');
                }
            }
            if (payload && typeof payload === 'object') {
                Object.defineProperty(payload, RESPONSE_BYTES, {
                    configurable: false,
                    enumerable: false,
                    value: Buffer.byteLength(text, 'utf8')
                });
            }
            return payload;
        } catch (error) {
            if (error && error.details && /^autotask_/.test(String(error.details.code || ''))) throw error;
            if (error && error.name === 'AbortError') {
                throw new AutotaskError(504, 'Autotask did not respond before the timeout', 'autotask_timeout');
            }
            throw new AutotaskError(502, 'No Fries could not reach Autotask', 'autotask_unreachable');
        } finally {
            clearTimeout(timer);
        }
    }

    function assertWriteEnabled() {
        const current = status();
        if (!current.writeOperationsEnabled) {
            throw new AutotaskError(503, 'Autotask write operations are not enabled', 'autotask_write_disabled');
        }
    }

    return {
        create,
        createTicket: (payload) => create('Tickets', payload),
        createTicketNote: (payload) => create('TicketNotes', payload),
        get,
        getContact: (id) => get('Contacts', id),
        getTicket: (id) => get('Tickets', id),
        getTicketNote: (id) => get('TicketNotes', id),
        health,
        query,
        queryTicketNotes: (filter, options) => query('TicketNotes', filter, options),
        queryTickets: (filter, options) => query('Tickets', filter, options),
        status,
        update,
        updateTicket: (id, payload) => update('Tickets', id, payload)
    };
}

async function buildApiUrl(auth, pathOrUrl) {
    const base = await auth.getApiBase();
    let url;
    try {
        const value = String(pathOrUrl || '');
        url = /^https:\/\//i.test(value)
            ? new URL(value)
            : new URL(value.replace(/^\/+/, ''), `${base}/`);
    } catch (error) {
        throw new AutotaskError(502, 'Autotask returned an invalid pagination URL', 'autotask_pagination_invalid');
    }
    const expected = new URL(base);
    const expectedPath = expected.pathname.replace(/\/$/, '');
    if (url.origin !== expected.origin || !url.pathname.startsWith(`${expectedPath}/`)) {
        throw new AutotaskError(502, 'Autotask returned an unsafe pagination URL', 'autotask_url_rejected');
    }
    return url.toString();
}

function providerHttpError(status, mutation) {
    const details = { providerStatus: Number(status || 0) };
    if (mutation && [400, 404, 422].includes(Number(status))) details.providerEffectAbsent = true;
    if (status === 401) return new AutotaskError(502, 'The Autotask API identity is invalid or expired', 'autotask_auth_failed', details);
    if (status === 403) return new AutotaskError(502, 'The Autotask API identity lacks the required permission', 'autotask_access_denied', details);
    if (status === 404) return new AutotaskError(404, 'The Autotask record was not found', 'autotask_record_not_found', details);
    if (status === 409) return new AutotaskError(409, 'The Autotask record changed concurrently', 'autotask_conflict', details);
    if (status === 429) return new AutotaskError(503, 'Autotask rate-limited the request; wait before retrying', 'autotask_rate_limited', details);
    if (status === 400 || status === 422) return new AutotaskError(422, 'Autotask rejected the requested record', 'autotask_validation_failed', details);
    return new AutotaskError(502, 'Autotask could not complete the request', 'autotask_provider_error', details);
}

function normaliseMutationResult(payload) {
    const source = payload && typeof payload === 'object' ? payload : {};
    const itemId = source.itemId != null ? source.itemId
        : source.id != null ? source.id
            : source.item && source.item.id != null ? source.item.id : null;
    return {
        itemId: itemId == null ? '' : String(itemId),
        item: source.item && typeof source.item === 'object' ? source.item : null
    };
}

function extractQueryPage(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.items)) {
        throw new AutotaskError(502, 'Autotask returned an invalid query collection', 'autotask_query_response_invalid');
    }
    const details = payload.pageDetails;
    if (details != null) {
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            throw new AutotaskError(502, 'Autotask returned invalid query pagination metadata', 'autotask_pagination_invalid');
        }
        for (const name of ['nextPageUrl', 'prevPageUrl']) {
            if (details[name] != null && typeof details[name] !== 'string') {
                throw new AutotaskError(502, 'Autotask returned invalid query pagination metadata', 'autotask_pagination_invalid');
            }
        }
        for (const name of ['count', 'requestCount']) {
            if (details[name] != null && (!Number.isSafeInteger(details[name]) || details[name] < 0)) {
                throw new AutotaskError(502, 'Autotask returned invalid query pagination metadata', 'autotask_pagination_invalid');
            }
        }
    }
    return { items: payload.items, next: extractNext(payload) };
}

function extractItem(payload) {
    if (payload && payload.item && !Array.isArray(payload.item)) return payload.item;
    if (payload && payload.items && payload.items.length === 1) return payload.items[0];
    if (payload && typeof payload === 'object' && payload.id != null) return payload;
    throw new AutotaskError(502, 'Autotask did not return the requested record', 'autotask_record_invalid');
}

function extractNext(payload) {
    return cleanText(payload && payload.pageDetails && payload.pageDetails.nextPageUrl, 3000);
}

function normaliseFilter(filter) {
    if (!Array.isArray(filter) || !filter.length || filter.length > 20) {
        throw new AutotaskError(400, 'An exact bounded Autotask filter is required', 'autotask_filter_invalid');
    }
    return filter.map((entry) => {
        const item = entry && typeof entry === 'object' ? entry : {};
        const op = cleanText(item.op, 20);
        const field = cleanText(item.field, 80);
        const udf = item.udf === true;
        const fieldValid = udf
            ? /^[A-Za-z][A-Za-z0-9 _-]{0,44}$/.test(field)
            : /^[A-Za-z][A-Za-z0-9]*$/.test(field);
        if (!['eq', 'neq', 'noteq', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains', 'beginsWith', 'endsWith'].includes(op) || !fieldValid) {
            throw new AutotaskError(400, 'An Autotask filter is invalid', 'autotask_filter_invalid');
        }
        const normalised = { op, field, value: item.value };
        if (udf) normalised.udf = true;
        return normalised;
    });
}

function normaliseFields(fields) {
    if (fields == null) return [];
    if (!Array.isArray(fields) || fields.length > 40 || fields.some((field) => !/^[A-Za-z][A-Za-z0-9]*$/.test(String(field)))) {
        throw new AutotaskError(400, 'The requested Autotask fields are invalid', 'autotask_fields_invalid');
    }
    return fields.map(String);
}

function requireEntity(value) {
    const entity = String(value || '').trim();
    const permitted = new Set(['Tickets', 'TicketNotes', 'Contacts']);
    if (!permitted.has(entity)) {
        throw new AutotaskError(400, 'The Autotask entity is not permitted', 'autotask_entity_invalid');
    }
    return entity;
}

function requireNumericId(value, code) {
    const id = parseCanonicalProviderId(value);
    if (!id) throw new AutotaskError(400, 'A valid Autotask record ID is required', code);
    return id;
}

function requireObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new AutotaskError(400, 'A valid Autotask record is required', 'autotask_payload_invalid');
    }
    return value;
}

async function boundedResponseText(response) {
    return readBoundedResponseText(response, MAX_RESPONSE_BYTES, () => (
        new AutotaskError(502, 'Autotask returned more data than No Fries accepts', 'autotask_response_too_large')
    ));
}

function positiveInteger(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function cleanText(value, maximum) {
    return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum);
}

module.exports = {
    AutotaskError,
    buildApiUrl,
    createAutotaskClient,
    parseCanonicalProviderId,
    providerHttpError
};
