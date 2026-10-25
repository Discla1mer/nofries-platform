(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory(require('node:util').types.isProxy);
    else root.NoFriesNcscAssessmentClient = factory(function () { return false; });
}(typeof globalThis !== 'undefined' ? globalThis : this, function (isProxy) {
    'use strict';

    const PREFIX = '/api/dashboard/ncsc/assessments';
    const COMMAND_BYTES = 65536, PLANNING_BYTES = 1024 * 1024, RESPONSE_BYTES = 512 * 1024;
    const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/, DIGEST = /^[a-f0-9]{64}$/;
    const PROFILE_FIELDS = ['frameworkId', 'frameworkVersion', 'profileId', 'profileVersion', 'catalogueSha256', 'sourceCatalogueSha256'];
    const SUMMARY_FIELDS = ['assessmentId', 'moduleId', 'profileRef', 'status', 'revision', 'revisionSha256', 'createdAt', 'updatedAt', 'progress'];
    const ERRORS = Object.freeze({ ncsc_input_invalid: 400, ncsc_selected_scope_unsupported: 400,
        ncsc_access_denied: 403, ncsc_not_found: 404, ncsc_method_not_allowed: 405, ncsc_request_too_large: 413,
        ncsc_revision_conflict: 409, ncsc_idempotency_conflict: 409, ncsc_state_conflict: 409, ncsc_quota_exceeded: 409,
        ncsc_submission_unavailable: 409,
        ncsc_unavailable: 503, ncsc_outcome_ambiguous: 503 });

    function error(code, statusCode, ambiguous) {
        const result = new Error(code);
        result.name = 'NcscAssessmentClientError'; result.code = code; result.statusCode = statusCode;
        result.ambiguous = ambiguous === true;
        return result;
    }
    function invalid() { throw error('ncsc_input_invalid', 400, false); }
    function tooLarge() { throw error('ncsc_request_too_large', 413, false); }
    function unavailable(mutation) { return error('ncsc_unavailable', 503, mutation); }
    function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) invalid(); return value; }
    function digest(value) { if (typeof value !== 'string' || !DIGEST.test(value)) invalid(); }
    function integer(value, maximum) {
        if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0) || value > maximum) invalid();
        return value;
    }
    function text(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 4000) invalid();
        for (let index = 0; index < value.length; index += 1) {
            const unit = value.charCodeAt(index);
            if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) invalid();
            if (unit >= 0xd800 && unit <= 0xdbff) {
                const next = value.charCodeAt(++index);
                if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
            }
        }
        return value;
    }
    function timestamp(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
            !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
        return value;
    }
    function freeze(value) {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
        return value;
    }
    function record(value, required, optional) {
        if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
        const allowed = required.concat(optional || []), keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
        if (keys.length > allowed.length || required.some(key => !Object.hasOwn(descriptors, key)) ||
            keys.some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) invalid();
        return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    }
    function utf8Length(value) {
        let bytes = 0;
        for (let index = 0; index < value.length; index += 1) {
            const unit = value.charCodeAt(index);
            if (unit <= 0x7f) bytes += 1;
            else if (unit <= 0x7ff) bytes += 2;
            else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
                bytes += 4; index += 1;
            } else bytes += 3;
        }
        return bytes;
    }

    // JSON data is copied through own data descriptors before any await. Native
    // browsers cannot identify Proxy objects; host adapters are trusted code.
    // The CommonJS path additionally rejects proxies without invoking traps.
    function copyJson(input, maximum, maxNodes, maxDepth) {
        let bytes = 0, nodes = 0;
        const active = new Set();
        function count(amount) { bytes += amount; if (bytes > maximum) tooLarge(); }
        function string(value) { if (value.length > maximum) tooLarge(); count(utf8Length(JSON.stringify(value))); return value; }
        function visit(value, depth) {
            if (++nodes > maxNodes || depth > maxDepth) invalid();
            if (value === null) { count(4); return null; }
            if (typeof value === 'string') return string(value);
            if (typeof value === 'boolean') { count(value ? 4 : 5); return value; }
            if (typeof value === 'number') {
                if (!Number.isFinite(value) || Object.is(value, -0)) invalid();
                count(String(value).length); return value;
            }
            if (!value || typeof value !== 'object' || isProxy(value) || active.has(value)) invalid();
            const array = Array.isArray(value), prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
            if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) invalid();
            if (keys.length > maxNodes) invalid();
            active.add(value);
            let result;
            if (array) {
                const length = Object.getOwnPropertyDescriptor(value, 'length').value;
                if (length > maxNodes || keys.length !== length + 1) invalid();
                count(2 + Math.max(0, length - 1)); result = [];
                for (let index = 0; index < length; index += 1) {
                    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
                    result.push(visit(descriptor.value, depth + 1));
                }
            } else {
                result = {}; count(2 + Math.max(0, keys.length - 1));
                for (const key of keys) {
                    if (typeof key !== 'string') invalid();
                    const descriptor = Object.getOwnPropertyDescriptor(value, key);
                    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
                    string(key); count(1);
                    Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1),
                        enumerable: true, writable: true, configurable: true });
                }
            }
            active.delete(value); return result;
        }
        return { value: visit(input, 0), bytes };
    }

    function validateMetadata(input) {
        const value = copyJson(input, RESPONSE_BYTES, 32768, 32).value;
        record(value, ['schemaVersion', 'moduleId', 'profileRef', 'title', 'description', 'attribution', 'claim',
            'licence', 'limitations', 'domains', 'controls', 'questions', 'responseOptions'], ['sourceDisclosure']);
        if (value.schemaVersion !== 1 || value.moduleId !== 'cyber_security') invalid();
        record(value.profileRef, PROFILE_FIELDS);
        PROFILE_FIELDS.slice(0, 4).forEach(key => identifier(value.profileRef[key]));
        PROFILE_FIELDS.slice(4).forEach(key => digest(value.profileRef[key]));
        ['title', 'description', 'attribution', 'claim'].forEach(key => text(value[key]));
        if (Object.hasOwn(value, 'sourceDisclosure')) text(value.sourceDisclosure);
        record(value.licence, ['label', 'url']); text(value.licence.label);
        if (value.licence.url !== 'https://creativecommons.org/licenses/by/4.0/') invalid();
        strings(value.limitations);
        const domains = collection(value.domains), controls = collection(value.controls), questions = collection(value.questions),
            options = collection(value.responseOptions);
        for (const domain of domains.values()) {
            record(domain, ['id', 'order', 'title', 'guidance']); integer(domain.order, 1000000); text(domain.title); guidance(domain.guidance);
        }
        for (const control of controls.values()) {
            record(control, ['id', 'domainId', 'order', 'title', 'guidance']);
            if (!domains.has(control.domainId)) invalid();
            integer(control.order, 1000000); text(control.title); guidance(control.guidance);
        }
        for (const option of options.values()) {
            record(option, ['id', 'label', 'applicable']); text(option.label);
            if (typeof option.applicable !== 'boolean') invalid();
        }
        for (const question of questions.values()) {
            record(question, ['id', 'controlId', 'order', 'prompt', 'guidance', 'responseOptionIds'], ['sources']);
            if (!controls.has(question.controlId)) invalid();
            integer(question.order, 1000000); text(question.prompt); guidance(question.guidance);
            if (Object.hasOwn(question, 'sources')) sourceLinks(question.sources);
            if (!Array.isArray(question.responseOptionIds) || !question.responseOptionIds.length ||
                new Set(question.responseOptionIds).size !== question.responseOptionIds.length ||
                question.responseOptionIds.some(id => !options.has(id))) invalid();
        }
        if ([...domains.keys()].some(id => !value.controls.some(control => control.domainId === id)) ||
            [...controls.keys()].some(id => !value.questions.some(question => question.controlId === id))) invalid();
        return freeze(value);
    }
    function collection(value) {
        if (!Array.isArray(value) || !value.length || value.length > 256) invalid();
        const result = new Map();
        for (const item of value) {
            if (!item || typeof item !== 'object') invalid();
            const id = identifier(item.id); if (result.has(id)) invalid(); result.set(id, item);
        }
        return result;
    }
    function strings(value) { if (!Array.isArray(value) || value.length > 256) invalid(); value.forEach(text); }
    function guidance(value) { record(value, ['summary', 'evidenceExamples', 'startingActions']); text(value.summary); strings(value.evidenceExamples); strings(value.startingActions); }
    function sourceLinks(value) {
        if (!Array.isArray(value) || !value.length || value.length > 16) invalid();
        const ids = new Set();
        for (const source of value) {
            record(source, ['id', 'title', 'url', 'lastVerifiedAt']);
            identifier(source.id); text(source.title);
            if (ids.has(source.id)) invalid();
            ids.add(source.id);
            let url;
            try { url = new URL(source.url); } catch (_) { invalid(); }
            if (typeof source.url !== 'string' || url.href !== source.url || url.origin !== 'https://www.ncsc.govt.nz' ||
                url.username || url.password || url.search || url.hash) invalid();
            if (typeof source.lastVerifiedAt !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(source.lastVerifiedAt) ||
                !Number.isFinite(Date.parse(source.lastVerifiedAt)) ||
                new Date(source.lastVerifiedAt).toISOString().slice(0, 10) !== source.lastVerifiedAt) invalid();
        }
    }

    /** Explicit transport only. This client neither grants access nor chooses
     * operation IDs, retries, storage, current tenant selection or UI readiness.
     */
    function createClient(adapters) {
        const supplied = record(adapters, ['metadata', 'fetch']);
        if (typeof supplied.fetch !== 'function') invalid();
        const metadata = validateMetadata(supplied.metadata), fetch = supplied.fetch;
        const questions = new Map(metadata.questions.map(question => [question.id, question]));
        const options = new Map(metadata.responseOptions.map(option => [option.id, option]));

        function answer(input, allowClear) {
            const row = record(input, ['itemId', 'optionId', 'rationale']), question = questions.get(identifier(row.itemId));
            if (!question) invalid();
            if (row.optionId === null) {
                if (!allowClear || row.rationale !== null) invalid();
            } else {
                identifier(row.optionId);
                if (!question.responseOptionIds.includes(row.optionId)) invalid();
                if (options.get(row.optionId).applicable) { if (row.rationale !== null) invalid(); }
                else text(record(row.rationale, ['text']).text);
            }
            return { itemId: row.itemId, optionId: row.optionId,
                rationale: row.rationale === null ? null : { text: row.rationale.text } };
        }
        function normalise(input, maximum) {
            const row = record(copyJson(input, maximum, 4096, 16).value,
                ['assessmentId', 'action', 'idempotencyKey', 'expectedRevision', 'payload']);
            const assessmentId = identifier(row.assessmentId), idempotencyKey = identifier(row.idempotencyKey);
            let payload;
            if (row.action === 'create') {
                if (row.expectedRevision !== null) invalid();
                const source = record(row.payload, ['scopePopulation']);
                payload = { scopePopulation: { description: text(record(source.scopePopulation, ['description']).description) } };
            } else if (row.action === 'save') {
                integer(row.expectedRevision, Number.MAX_SAFE_INTEGER);
                const source = record(row.payload, ['responses']);
                if (!Array.isArray(source.responses) || !source.responses.length || source.responses.length > questions.size) invalid();
                const responses = source.responses.map(value => answer(value, true));
                if (new Set(responses.map(value => value.itemId)).size !== responses.length) invalid();
                responses.sort((left, right) => left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0);
                payload = { responses };
            } else if (row.action === 'submit') {
                integer(row.expectedRevision, Number.MAX_SAFE_INTEGER); record(row.payload, []); payload = {};
            } else invalid();
            return freeze({ assessmentId, action: row.action, idempotencyKey, expectedRevision: row.expectedRevision, payload });
        }
        function normaliseCommand(input) { return normalise(input, COMMAND_BYTES); }
        function commandByteLength(input) { return utf8Length(JSON.stringify(normalise(input, PLANNING_BYTES))); }
        function profile(value) {
            record(value, PROFILE_FIELDS);
            if (PROFILE_FIELDS.some(key => value[key] !== metadata.profileRef[key])) invalid();
        }
        function summary(value, detail) {
            record(value, detail ? SUMMARY_FIELDS.concat(['scopePopulation', 'responses', 'submission']) : SUMMARY_FIELDS);
            identifier(value.assessmentId); profile(value.profileRef); digest(value.revisionSha256);
            if (value.moduleId !== metadata.moduleId || !['created', 'in-progress', 'submitted'].includes(value.status)) invalid();
            integer(value.revision, 128); timestamp(value.createdAt); timestamp(value.updatedAt);
            if (value.createdAt > value.updatedAt ||
                (value.status === 'created' && (value.revision !== 0 || value.createdAt !== value.updatedAt)) ||
                (value.status === 'in-progress' && (value.revision < 1 || value.revision > 127)) ||
                (value.status === 'submitted' && value.revision < 2)) invalid();
            const progress = record(value.progress, ['total', 'answered', 'missing', 'unknown', 'notApplicableClaims']);
            Object.values(progress).forEach(number => integer(number, questions.size));
            if (progress.total !== questions.size || progress.answered + progress.missing !== progress.total ||
                progress.unknown + progress.notApplicableClaims > progress.answered ||
                (value.status === 'created' && progress.answered !== 0) ||
                (value.status === 'submitted' && progress.missing !== 0)) invalid();
        }
        function detail(value, assessmentId) {
            summary(value, true);
            if (value.assessmentId !== assessmentId) invalid();
            text(record(value.scopePopulation, ['description']).description);
            if (!Array.isArray(value.responses) || value.responses.length > questions.size) invalid();
            const answers = value.responses.map(row => answer(row, false));
            if (new Set(answers.map(row => row.itemId)).size !== answers.length ||
                value.progress.answered !== answers.length ||
                value.progress.unknown !== answers.filter(row => row.optionId === 'unknown').length ||
                value.progress.notApplicableClaims !== answers.filter(row => !options.get(row.optionId).applicable).length) invalid();
            if (value.status !== 'submitted') { if (value.submission !== null) invalid(); return; }
            const submission = record(value.submission, ['revision', 'submittedAt', 'responseSetSha256', 'evaluation']);
            if (submission.revision !== value.revision || submission.submittedAt !== value.updatedAt) invalid();
            timestamp(submission.submittedAt); digest(submission.responseSetSha256);
            // Preserve the bounded ENG-003 result intact. Only consumed provenance
            // bindings are checked here; arithmetic and result-hash verification
            // remain with the canonical server evaluator.
            const evaluation = submission.evaluation;
            if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation) || evaluation.schemaVersion !== 1) invalid();
            digest(evaluation.outputSha256);
            const provenance = evaluation.provenance;
            if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) invalid();
            profile(provenance.profileRef);
            if (provenance.moduleId !== metadata.moduleId || provenance.assessmentId !== assessmentId ||
                provenance.assessmentRevision !== 'rev-' + value.revision || provenance.scoreAsOf !== submission.submittedAt) invalid();
        }
        function validateResult(value, kind, selected) {
            if (kind === 'list') {
                record(value, ['schemaVersion', 'assessments', 'nextAfterAssessmentId']);
                if (!Array.isArray(value.assessments) || value.assessments.length > selected.limit) invalid();
                let previous = selected.afterAssessmentId;
                for (const item of value.assessments) {
                    summary(item, false);
                    if (previous !== null && item.assessmentId <= previous) invalid();
                    previous = item.assessmentId;
                }
                if (value.nextAfterAssessmentId !== null && (!value.assessments.length ||
                    identifier(value.nextAfterAssessmentId) !== previous)) invalid();
            } else {
                record(value, kind === 'read' ? ['schemaVersion', 'assessment'] : ['schemaVersion', 'action', 'assessment']);
                detail(value.assessment, selected.assessmentId);
                if (kind !== 'read') {
                    if (value.action !== kind || value.assessment.revision !== (kind === 'create' ? 0 : selected.expectedRevision + 1) ||
                        value.assessment.status !== ({ create: 'created', save: 'in-progress', submit: 'submitted' })[kind]) invalid();
                    if (kind === 'create' && value.assessment.scopePopulation.description !== selected.payload.scopePopulation.description) invalid();
                    if (kind === 'save') for (const patch of selected.payload.responses) {
                        const saved = value.assessment.responses.find(row => row.itemId === patch.itemId);
                        if (patch.optionId === null ? saved !== undefined : !saved || saved.optionId !== patch.optionId ||
                            (patch.rationale === null ? saved.rationale !== null : saved.rationale?.text !== patch.rationale.text)) invalid();
                    }
                }
            }
            if (value.schemaVersion !== 1) invalid();
            return freeze(value);
        }
        async function request(url, kind, selected, signal, body) {
            const mutation = !['list', 'read'].includes(kind);
            const controller = new AbortController();
            let timer;
            let rejectLifetime;
            const lifetime = new Promise((resolve, reject) => { rejectLifetime = reject; });
            const cancel = () => { controller.abort(); rejectLifetime(unavailable(mutation)); };
            try {
                if (signal !== undefined) {
                    if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') invalid();
                    signal.addEventListener('abort', cancel, { once: true });
                    if (signal.aborted) { cancel(); return await lifetime; }
                }
                // Bound the complete response, including a stalled body stream.
                // A timeout never proves a server mutation was cancelled.
                timer = setTimeout(cancel, 12000);
                return await Promise.race([receive(url, kind, selected, controller.signal, body), lifetime]);
            } finally {
                clearTimeout(timer);
                if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', cancel);
            }
        }
        async function receive(url, kind, selected, signal, body) {
            const mutation = !['list', 'read'].includes(kind);
            let response, value;
            try {
                response = await fetch(url, { method: mutation ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
                    redirect: 'error', headers: { Accept: 'application/json', ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
                    ...(signal === undefined ? {} : { signal }), ...(mutation ? { body } : {}) });
                if (!response || response.redirected === true || response.type === 'opaqueredirect' || response.type === 'opaque' ||
                    !Number.isInteger(response.status)) invalid();
                value = await readJson(response);
            } catch { throw unavailable(mutation); }
            const expectedStatus = kind === 'create' ? 201 : 200;
            if (response.status !== expectedStatus) {
                try { record(value, ['code']); if (!Object.hasOwn(ERRORS, value.code) || ERRORS[value.code] !== response.status) invalid(); }
                catch { throw unavailable(mutation); }
                throw error(value.code, response.status, mutation && response.status === 503);
            }
            try { return validateResult(value, kind, selected); }
            catch { throw unavailable(mutation); }
        }
        async function mutate(kind, input, settings) {
            const command = normaliseCommand(input), config = record(settings === undefined ? {} : settings, [], ['signal']);
            if (command.action !== kind) invalid();
            const create = kind === 'create', url = create ? PREFIX : PREFIX + '/' + encodeURIComponent(command.assessmentId) + '/' + kind;
            const body = JSON.stringify({ ...(create ? { assessmentId: command.assessmentId } : {}), idempotencyKey: command.idempotencyKey,
                expectedRevision: command.expectedRevision, payload: command.payload });
            return request(url, kind, command, config.signal, body);
        }
        return Object.freeze({ normaliseCommand, commandByteLength,
            async list(input) {
                const config = record(input === undefined ? {} : input, [], ['limit', 'afterAssessmentId', 'signal']);
                const limit = config.limit === undefined ? 50 : integer(config.limit, 100);
                if (limit < 1) invalid();
                const afterAssessmentId = config.afterAssessmentId === undefined || config.afterAssessmentId === null
                    ? null : identifier(config.afterAssessmentId);
                const url = PREFIX + '?limit=' + limit + (afterAssessmentId === null ? '' : '&afterAssessmentId=' + encodeURIComponent(afterAssessmentId));
                return request(url, 'list', { limit, afterAssessmentId }, config.signal);
            },
            async read(assessmentId, settings) {
                identifier(assessmentId);
                const config = record(settings === undefined ? {} : settings, [], ['signal']);
                return request(PREFIX + '/' + encodeURIComponent(assessmentId), 'read', { assessmentId }, config.signal);
            },
            create: (command, settings) => mutate('create', command, settings),
            save: (command, settings) => mutate('save', command, settings),
            submit: (command, settings) => mutate('submit', command, settings)
        });
    }

    async function readJson(response) {
        const type = response.headers?.get('Content-Type');
        if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) invalid();
        const length = response.headers.get('Content-Length');
        if (length !== null && /^\d+$/.test(length) && Number(length) > RESPONSE_BYTES) invalid();
        let source;
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
            let bytes = 0; const parts = [];
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    if (!(chunk.value instanceof Uint8Array)) invalid();
                    bytes += chunk.value.byteLength; if (bytes > RESPONSE_BYTES) invalid();
                    parts.push(decoder.decode(chunk.value, { stream: true }));
                }
                parts.push(decoder.decode()); source = parts.join('');
            } catch (caught) {
                try { Promise.resolve(reader.cancel()).catch(function () {}); } catch { /* Keep the original transport failure. */ }
                throw caught;
            } finally { reader.releaseLock(); }
        } else {
            // An injected synthetic transport may implement text() without a
            // stream. Real Fetch responses take the bounded streaming path.
            source = await response.text();
            if (typeof source !== 'string' || source.length > RESPONSE_BYTES || utf8Length(source) > RESPONSE_BYTES) invalid();
        }
        return copyJson(JSON.parse(source), RESPONSE_BYTES, 32768, 32).value;
    }

    return Object.freeze({ createClient });
}));
