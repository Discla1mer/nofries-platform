'use strict';

const crypto = require('crypto');
const { types: utilTypes } = require('util');

const FRAMEWORK_PROFILE_SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({
    profiles: 32,
    sources: 512,
    domains: 64,
    controls: 512,
    questions: 1024,
    responseOptions: 32,
    references: 64,
    listItems: 32,
    keyBytes: 256,
    textBytes: 4096,
    urlBytes: 2048,
    profileBytes: 1024 * 1024,
    registryBytes: 4 * 1024 * 1024,
    graphNodes: 16000,
    registryGraphNodes: 512000,
    graphDepth: 128
});

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class FrameworkProfileValidationError extends Error {
    constructor(code, path) {
        super(`Framework profile validation failed (${code}) at ${path}`);
        this.name = 'FrameworkProfileValidationError';
        this.code = code;
        this.path = path;
    }
}

class FrameworkProfileLookupError extends Error {
    constructor(code) {
        super(`Framework profile lookup failed (${code})`);
        this.name = 'FrameworkProfileLookupError';
        this.code = code;
    }
}

function publishFrameworkProfile(definition) {
    const normalized = normalizeFrameworkProfile(definition, { requireDigest: true });
    const calculatedDigest = digestNormalizedProfile(normalized);
    if (normalized.catalogueSha256 !== calculatedDigest) {
        fail('catalogue_digest_mismatch', '$.catalogueSha256');
    }
    return deepFreeze(normalized);
}

function calculateFrameworkProfileSha256(definition) {
    const normalized = normalizeFrameworkProfile(definition, { requireDigest: false });
    return digestNormalizedProfile(normalized);
}

function createFrameworkRegistry(definitions) {
    inspectValueGraph(
        definitions,
        '$',
        LIMITS.registryBytes,
        'registry_too_large',
        LIMITS.registryGraphNodes
    );
    assertDenseArray(definitions, '$', 1, LIMITS.profiles);

    const byProfile = new Map();
    const byFramework = new Map();
    const retained = [];
    let totalBytes = 0;

    definitions.forEach((definition, index) => {
        const published = publishFrameworkProfile(definition);
        const profileId = published.profile.id;
        const profileVersion = published.profile.version;
        const frameworkId = published.framework.id;
        const frameworkVersion = published.framework.version;
        let versions = byProfile.get(profileId);
        if (!versions) {
            versions = new Map();
            byProfile.set(profileId, versions);
        }
        if (versions.has(profileVersion)) {
            fail('duplicate_profile_version', `$[${index}].profile.version`);
        }

        let frameworkVersions = byFramework.get(frameworkId);
        if (!frameworkVersions) {
            frameworkVersions = new Map();
            byFramework.set(frameworkId, frameworkVersions);
        }
        const frameworkIdentity = selectFrameworkIdentity(published);
        const retainedFramework = frameworkVersions.get(frameworkVersion);
        if (retainedFramework && canonicalJson(retainedFramework) !== canonicalJson(frameworkIdentity)) {
            fail('framework_version_conflict', `$[${index}].framework.version`);
        }
        if (!retainedFramework) frameworkVersions.set(frameworkVersion, frameworkIdentity);

        totalBytes += Buffer.byteLength(canonicalJson(published), 'utf8');
        if (totalBytes > LIMITS.registryBytes) {
            fail('registry_too_large', '$');
        }
        versions.set(profileVersion, published);
        retained.push(published);
    });

    retained.sort(compareProfiles);

    return Object.freeze({
        getProfile(profileId, profileVersion) {
            validateLookupReference(profileId, profileVersion);
            const profile = byProfile.get(profileId)?.get(profileVersion);
            if (!profile) throw new FrameworkProfileLookupError('unsupported_framework_profile');
            return immutableClone(profile);
        },
        getFramework(frameworkId, frameworkVersion) {
            validateLookupReference(frameworkId, frameworkVersion);
            const framework = byFramework.get(frameworkId)?.get(frameworkVersion);
            if (!framework) throw new FrameworkProfileLookupError('unsupported_framework');
            return immutableClone(framework);
        },
        hasProfile(profileId, profileVersion) {
            validateLookupReference(profileId, profileVersion);
            return Boolean(byProfile.get(profileId)?.has(profileVersion));
        },
        listProfiles() {
            return immutableClone(retained.map((profile) => {
                const summary = {
                    frameworkId: profile.framework.id,
                    frameworkVersion: profile.framework.version,
                    profileId: profile.profile.id,
                    profileVersion: profile.profile.version,
                    title: profile.profile.title,
                    status: profile.status,
                    publishedAt: profile.publishedAt,
                    catalogueSha256: profile.catalogueSha256
                };
                if (profile.sourceCatalogueSha256) {
                    summary.sourceCatalogueSha256 = profile.sourceCatalogueSha256;
                }
                return summary;
            }));
        }
    });
}

function normalizeFrameworkProfile(definition, options) {
    inspectValueGraph(definition, '$');
    assertPlainObject(definition, '$');
    if (Buffer.byteLength(canonicalJson(definition), 'utf8') > LIMITS.profileBytes) {
        fail('profile_too_large', '$');
    }

    assertExactKeys(definition, [
        'schemaVersion', 'status', 'publishedAt', 'framework', 'profile', 'statements',
        'sources', 'domains', 'controls', 'questions', 'responseOptions'
    ], ['catalogueSha256', 'sourceCatalogueSha256'], '$');

    if (definition.schemaVersion !== FRAMEWORK_PROFILE_SCHEMA_VERSION) {
        fail('unsupported_schema_version', '$.schemaVersion');
    }
    assertEnum(definition.status, ['published'], '$.status');
    const publishedAt = copyDate(definition.publishedAt, '$.publishedAt');
    const framework = copyFramework(definition.framework);
    const profile = copyProfile(definition.profile);
    const statements = copyStatements(definition.statements);
    const sources = copySources(definition.sources);
    const domains = copyDomains(definition.domains);
    const controls = copyControls(definition.controls);
    const questions = copyQuestions(definition.questions);
    const responseOptions = copyResponseOptions(definition.responseOptions);

    const normalized = {
        schemaVersion: FRAMEWORK_PROFILE_SCHEMA_VERSION,
        status: 'published',
        publishedAt,
        framework,
        profile,
        statements,
        sources,
        domains,
        controls,
        questions,
        responseOptions
    };

    if (Object.hasOwn(definition, 'sourceCatalogueSha256')) {
        normalized.sourceCatalogueSha256 = copySha256(
            definition.sourceCatalogueSha256,
            '$.sourceCatalogueSha256'
        );
    }
    if (Object.hasOwn(definition, 'catalogueSha256')) {
        normalized.catalogueSha256 = copySha256(definition.catalogueSha256, '$.catalogueSha256');
    } else if (options.requireDigest) {
        fail('catalogue_digest_required', '$.catalogueSha256');
    }

    validateReferences(normalized);
    return normalized;
}

function copyFramework(value) {
    const path = '$.framework';
    assertPlainObject(value, path);
    assertExactKeys(value, ['id', 'version', 'title', 'authority', 'description', 'sourceIds'], [], path);
    return {
        id: copyId(value.id, `${path}.id`),
        version: copyVersion(value.version, `${path}.version`),
        title: copyText(value.title, `${path}.title`),
        authority: copyText(value.authority, `${path}.authority`),
        description: copyText(value.description, `${path}.description`),
        sourceIds: copyIdList(value.sourceIds, `${path}.sourceIds`, 1)
    };
}

function copyProfile(value) {
    const path = '$.profile';
    assertPlainObject(value, path);
    assertExactKeys(value, ['id', 'version', 'title', 'description', 'effectiveFrom', 'sourceIds'], [], path);
    return {
        id: copyId(value.id, `${path}.id`),
        version: copyVersion(value.version, `${path}.version`),
        title: copyText(value.title, `${path}.title`),
        description: copyText(value.description, `${path}.description`),
        effectiveFrom: copyDate(value.effectiveFrom, `${path}.effectiveFrom`),
        sourceIds: copyIdList(value.sourceIds, `${path}.sourceIds`, 1)
    };
}

function copyStatements(value) {
    const path = '$.statements';
    assertPlainObject(value, path);
    assertExactKeys(value, ['attribution', 'basis', 'claim', 'limitations'], [], path);
    return {
        attribution: copyText(value.attribution, `${path}.attribution`),
        basis: copyText(value.basis, `${path}.basis`),
        claim: copyText(value.claim, `${path}.claim`),
        limitations: copyTextList(value.limitations, `${path}.limitations`, 1)
    };
}

function copySources(values) {
    assertDenseArray(values, '$.sources', 1, LIMITS.sources);
    return values.map((value, index) => {
        const path = `$.sources[${index}]`;
        assertPlainObject(value, path);
        assertExactKeys(value, [
            'id', 'title', 'url', 'authority', 'version', 'lastVerifiedAt', 'rightsStatus'
        ], ['publishedAt', 'licence', 'licenceUrl', 'reviewDueAt', 'reviewCadence'], path);
        const source = {
            id: copyId(value.id, `${path}.id`),
            title: copyText(value.title, `${path}.title`),
            url: copyHttpsUrl(value.url, `${path}.url`),
            authority: copyText(value.authority, `${path}.authority`),
            version: copyVersion(value.version, `${path}.version`),
            lastVerifiedAt: copyDate(value.lastVerifiedAt, `${path}.lastVerifiedAt`),
            rightsStatus: copyRightsStatus(value.rightsStatus, `${path}.rightsStatus`)
        };
        if (Object.hasOwn(value, 'publishedAt')) {
            source.publishedAt = copyDate(value.publishedAt, `${path}.publishedAt`);
        }
        const hasLicence = Object.hasOwn(value, 'licence');
        const hasLicenceUrl = Object.hasOwn(value, 'licenceUrl');
        if (hasLicence !== hasLicenceUrl) fail('incomplete_licence_metadata', path);
        if (hasLicence) {
            source.licence = copyText(value.licence, `${path}.licence`);
            source.licenceUrl = copyHttpsUrl(value.licenceUrl, `${path}.licenceUrl`);
        }
        if (['verified', 'synthetic'].includes(source.rightsStatus) && !hasLicence) {
            fail('licence_metadata_required', path);
        }
        const hasReviewDueAt = Object.hasOwn(value, 'reviewDueAt');
        const hasReviewCadence = Object.hasOwn(value, 'reviewCadence');
        if (hasReviewDueAt !== hasReviewCadence) fail('incomplete_review_metadata', path);
        if (hasReviewDueAt) {
            source.reviewDueAt = copyDate(value.reviewDueAt, `${path}.reviewDueAt`);
            source.reviewCadence = copyId(value.reviewCadence, `${path}.reviewCadence`);
        }
        return source;
    });
}

function copyDomains(values) {
    assertDenseArray(values, '$.domains', 1, LIMITS.domains);
    return values.map((value, index) => {
        const path = `$.domains[${index}]`;
        assertPlainObject(value, path);
        assertExactKeys(value, ['id', 'order', 'title', 'guidance', 'sourceIds'], [], path);
        return {
            id: copyId(value.id, `${path}.id`),
            order: copyPositiveInteger(value.order, `${path}.order`),
            title: copyText(value.title, `${path}.title`),
            guidance: copyGuidance(value.guidance, `${path}.guidance`),
            sourceIds: copyIdList(value.sourceIds, `${path}.sourceIds`, 1)
        };
    });
}

function copyControls(values) {
    assertDenseArray(values, '$.controls', 1, LIMITS.controls);
    return values.map((value, index) => {
        const path = `$.controls[${index}]`;
        assertPlainObject(value, path);
        assertExactKeys(value, [
            'id', 'domainId', 'order', 'title', 'guidance', 'sourceIds', 'sourceReferences'
        ], [], path);
        return {
            id: copyId(value.id, `${path}.id`),
            domainId: copyId(value.domainId, `${path}.domainId`),
            order: copyPositiveInteger(value.order, `${path}.order`),
            title: copyText(value.title, `${path}.title`),
            guidance: copyGuidance(value.guidance, `${path}.guidance`),
            sourceIds: copyIdList(value.sourceIds, `${path}.sourceIds`, 1),
            sourceReferences: copySourceReferences(value.sourceReferences, `${path}.sourceReferences`)
        };
    });
}

function copyQuestions(values) {
    assertDenseArray(values, '$.questions', 1, LIMITS.questions);
    return values.map((value, index) => {
        const path = `$.questions[${index}]`;
        assertPlainObject(value, path);
        assertExactKeys(value, [
            'id', 'controlId', 'order', 'prompt', 'guidance', 'weight',
            'responseOptionIds', 'sourceIds'
        ], [], path);
        return {
            id: copyId(value.id, `${path}.id`),
            controlId: copyId(value.controlId, `${path}.controlId`),
            order: copyPositiveInteger(value.order, `${path}.order`),
            prompt: copyText(value.prompt, `${path}.prompt`),
            guidance: copyGuidance(value.guidance, `${path}.guidance`),
            weight: copyWeight(value.weight, `${path}.weight`),
            responseOptionIds: copyIdList(value.responseOptionIds, `${path}.responseOptionIds`, 2),
            sourceIds: copyIdList(value.sourceIds, `${path}.sourceIds`, 1)
        };
    });
}

function copyResponseOptions(values) {
    assertDenseArray(values, '$.responseOptions', 2, LIMITS.responseOptions);
    return values.map((value, index) => {
        const path = `$.responseOptions[${index}]`;
        assertPlainObject(value, path);
        assertExactKeys(value, ['id', 'label', 'applicable', 'implementationFactor'], [], path);
        const applicable = copyBoolean(value.applicable, `${path}.applicable`);
        const implementationFactor = copyImplementationFactor(
            value.implementationFactor,
            `${path}.implementationFactor`
        );
        if (!applicable && implementationFactor !== null) {
            fail('non_applicable_factor_must_be_null', `${path}.implementationFactor`);
        }
        return {
            id: copyId(value.id, `${path}.id`),
            label: copyText(value.label, `${path}.label`),
            applicable,
            implementationFactor
        };
    });
}

function copyGuidance(value, path) {
    assertPlainObject(value, path);
    assertExactKeys(value, ['summary', 'evidenceExamples', 'startingActions'], [], path);
    return {
        summary: copyText(value.summary, `${path}.summary`),
        evidenceExamples: copyTextList(value.evidenceExamples, `${path}.evidenceExamples`, 0),
        startingActions: copyTextList(value.startingActions, `${path}.startingActions`, 0)
    };
}

function copySourceReferences(values, path) {
    assertDenseArray(values, path, 0, LIMITS.references);
    return values.map((value, index) => {
        const itemPath = `${path}[${index}]`;
        assertPlainObject(value, itemPath);
        assertExactKeys(value, ['sourceId', 'referenceId', 'order'], [], itemPath);
        return {
            sourceId: copyId(value.sourceId, `${itemPath}.sourceId`),
            referenceId: copyId(value.referenceId, `${itemPath}.referenceId`),
            order: copyPositiveInteger(value.order, `${itemPath}.order`)
        };
    });
}

function validateReferences(profile) {
    const sourceIds = uniqueIds(profile.sources, '$.sources');
    const domainIds = uniqueIds(profile.domains, '$.domains');
    const controlIds = uniqueIds(profile.controls, '$.controls');
    uniqueIds(profile.questions, '$.questions');
    const responseOptionIds = uniqueIds(profile.responseOptions, '$.responseOptions');
    const responseOptionById = new Map(profile.responseOptions.map((option) => [option.id, option]));

    assertUniqueOrders(profile.domains, '$.domains');
    assertUniqueOrdersWithin(profile.controls, '$.controls', (control) => control.domainId);
    assertUniqueOrdersWithin(profile.questions, '$.questions', (question) => question.controlId);

    assertReferences(profile.framework.sourceIds, sourceIds, '$.framework.sourceIds', 'unknown_source');
    assertReferences(profile.profile.sourceIds, sourceIds, '$.profile.sourceIds', 'unknown_source');

    profile.domains.forEach((domain, index) => {
        assertReferences(domain.sourceIds, sourceIds, `$.domains[${index}].sourceIds`, 'unknown_source');
        if (!profile.controls.some((control) => control.domainId === domain.id)) {
            fail('domain_without_control', `$.domains[${index}].id`);
        }
    });

    profile.controls.forEach((control, index) => {
        if (!domainIds.has(control.domainId)) {
            fail('unknown_domain', `$.controls[${index}].domainId`);
        }
        assertReferences(control.sourceIds, sourceIds, `$.controls[${index}].sourceIds`, 'unknown_source');
        control.sourceReferences.forEach((reference, referenceIndex) => {
            if (!sourceIds.has(reference.sourceId)) {
                fail('unknown_source', `$.controls[${index}].sourceReferences[${referenceIndex}].sourceId`);
            }
            if (!control.sourceIds.includes(reference.sourceId)) {
                fail('source_reference_not_declared', `$.controls[${index}].sourceReferences[${referenceIndex}].sourceId`);
            }
        });
        assertUniqueComposite(
            control.sourceReferences,
            (item) => `${item.sourceId}\u0000${item.referenceId}`,
            `$.controls[${index}].sourceReferences`,
            'duplicate_source_reference'
        );
        assertUniqueOrders(control.sourceReferences, `$.controls[${index}].sourceReferences`);
        if (!profile.questions.some((question) => question.controlId === control.id)) {
            fail('control_without_question', `$.controls[${index}].id`);
        }
    });

    let positiveWeightFound = false;
    profile.questions.forEach((question, index) => {
        if (!controlIds.has(question.controlId)) {
            fail('unknown_control', `$.questions[${index}].controlId`);
        }
        if (question.weight > 0) positiveWeightFound = true;
        assertReferences(question.responseOptionIds, responseOptionIds, `$.questions[${index}].responseOptionIds`, 'unknown_response_option');
        assertReferences(question.sourceIds, sourceIds, `$.questions[${index}].sourceIds`, 'unknown_source');
        if (!question.responseOptionIds.some((optionId) => {
            const option = responseOptionById.get(optionId);
            return option.applicable && typeof option.implementationFactor === 'number';
        })) {
            fail('unusable_response_options', `$.questions[${index}].responseOptionIds`);
        }
    });
    if (!positiveWeightFound) fail('positive_weight_required', '$.questions');

    const usedSourceIds = new Set([
        ...profile.framework.sourceIds,
        ...profile.profile.sourceIds,
        ...profile.domains.flatMap((domain) => domain.sourceIds),
        ...profile.controls.flatMap((control) => [
            ...control.sourceIds,
            ...control.sourceReferences.map((reference) => reference.sourceId)
        ]),
        ...profile.questions.flatMap((question) => question.sourceIds)
    ]);
    profile.sources.forEach((source, index) => {
        if (!usedSourceIds.has(source.id)) fail('unused_source', `$.sources[${index}].id`);
    });
    profile.responseOptions.forEach((option, index) => {
        if (!profile.questions.some((question) => question.responseOptionIds.includes(option.id))) {
            fail('unused_response_option', `$.responseOptions[${index}].id`);
        }
    });
}

function inspectValueGraph(
    value,
    path,
    byteLimit = LIMITS.profileBytes,
    tooLargeCode = 'profile_too_large',
    nodeLimit = LIMITS.graphNodes
) {
    let nodes = 0;
    let bytes = 0;
    const active = new WeakSet();
    const stack = [{ current: value, currentPath: path, depth: 0, leaving: false }];

    while (stack.length > 0) {
        const entry = stack.pop();
        const { current, currentPath, depth, leaving } = entry;
        if (leaving) {
            active.delete(current);
            continue;
        }
        nodes += 1;
        if (nodes > nodeLimit) fail('definition_too_complex', '$');
        if (depth > LIMITS.graphDepth) fail('definition_too_deep', '$');

        if (current === null || typeof current === 'boolean') {
            bytes += 5;
            if (bytes > byteLimit) fail(tooLargeCode, '$');
            continue;
        }
        if (typeof current === 'string') {
            bytes += Buffer.byteLength(current, 'utf8') + 2;
            if (bytes > byteLimit) fail(tooLargeCode, '$');
            continue;
        }
        if (typeof current === 'number') {
            if (!Number.isFinite(current) || Object.is(current, -0)) fail('unsupported_number', currentPath);
            bytes += 24;
            if (bytes > byteLimit) fail(tooLargeCode, '$');
            continue;
        }
        if (typeof current !== 'object') fail('unsupported_value', currentPath);
        if (utilTypes.isProxy(current)) fail('proxy_rejected', currentPath);
        bytes += 2;
        if (bytes > byteLimit) fail(tooLargeCode, '$');

        const prototype = Object.getPrototypeOf(current);
        const isArray = Array.isArray(current);
        if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            fail('non_plain_object', currentPath);
        }
        if (active.has(current)) fail('cyclic_definition', currentPath);
        active.add(current);
        stack.push({ current, currentPath, depth, leaving: true });

        const keys = Reflect.ownKeys(current);
        if (keys.some((key) => typeof key === 'symbol')) fail('symbol_key_rejected', currentPath);
        if (isArray) {
            if (current.length > LIMITS.graphNodes) fail('definition_too_complex', currentPath);
            for (let index = 0; index < current.length; index += 1) {
                if (!Object.hasOwn(current, index)) fail('sparse_array_rejected', `${currentPath}[${index}]`);
            }
            const allowed = new Set(['length', ...Array.from({ length: current.length }, (_, index) => String(index))]);
            if (keys.some((key) => !allowed.has(key))) fail('array_property_rejected', currentPath);
        }

        const descriptors = Object.getOwnPropertyDescriptors(current);
        Object.keys(descriptors).reverse().forEach((key) => {
            const keyBytes = Buffer.byteLength(key, 'utf8');
            if (keyBytes > LIMITS.keyBytes) fail('property_key_too_long', currentPath);
            bytes += keyBytes + 3;
            if (bytes > byteLimit) fail(tooLargeCode, '$');
            if (FORBIDDEN_KEYS.has(key)) fail('forbidden_key', currentPath);
            const descriptor = descriptors[key];
            if (descriptor.get || descriptor.set || !Object.hasOwn(descriptor, 'value')) {
                fail('accessor_rejected', currentPath);
            }
            if (key !== 'length' && !descriptor.enumerable) {
                fail('non_json_property_rejected', currentPath);
            }
            if (key !== 'length') {
                stack.push({
                    current: descriptor.value,
                    currentPath: isArray ? `${currentPath}[${key}]` : `${currentPath}.*`,
                    depth: depth + 1,
                    leaving: false
                });
            }
        });
    }
}

function assertPlainObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object_required', path);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('plain_object_required', path);
}

function assertExactKeys(value, required, optional, path) {
    const allowed = new Set([...required, ...optional]);
    Object.keys(value).forEach((key) => {
        if (!allowed.has(key)) fail('unknown_field', `${path}.[unknown]`);
    });
    required.forEach((key) => {
        if (!Object.hasOwn(value, key)) fail('required_field_missing', `${path}.${key}`);
    });
}

function assertDenseArray(value, path, minimum, maximum) {
    if (!Array.isArray(value)) fail('array_required', path);
    if (value.length < minimum || value.length > maximum) fail('array_size_out_of_bounds', path);
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail('sparse_array_rejected', `${path}[${index}]`);
    }
}

function uniqueIds(items, path) {
    const ids = new Set();
    items.forEach((item, index) => {
        if (ids.has(item.id)) fail('duplicate_id', `${path}[${index}].id`);
        ids.add(item.id);
    });
    return ids;
}

function assertUniqueOrders(items, path) {
    const orders = new Set();
    items.forEach((item, index) => {
        if (orders.has(item.order)) fail('duplicate_order', `${path}[${index}].order`);
        orders.add(item.order);
    });
}

function assertUniqueOrdersWithin(items, path, groupSelector) {
    const groups = new Map();
    items.forEach((item, index) => {
        const group = groupSelector(item);
        let orders = groups.get(group);
        if (!orders) {
            orders = new Set();
            groups.set(group, orders);
        }
        if (orders.has(item.order)) fail('duplicate_order', `${path}[${index}].order`);
        orders.add(item.order);
    });
}

function assertUniqueComposite(items, selector, path, code) {
    const values = new Set();
    items.forEach((item, index) => {
        const selected = selector(item);
        if (values.has(selected)) fail(code, `${path}[${index}]`);
        values.add(selected);
    });
}

function assertReferences(values, known, path, code) {
    values.forEach((value, index) => {
        if (!known.has(value)) fail(code, `${path}[${index}]`);
    });
}

function copyIdList(value, path, minimum) {
    assertDenseArray(value, path, minimum, LIMITS.references);
    const output = value.map((item, index) => copyId(item, `${path}[${index}]`));
    assertUniqueComposite(output, (item) => item, path, 'duplicate_reference');
    return output;
}

function copyTextList(value, path, minimum) {
    assertDenseArray(value, path, minimum, LIMITS.listItems);
    return value.map((item, index) => copyText(item, `${path}[${index}]`));
}

function copyId(value, path) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail('invalid_id', path);
    return value;
}

function copyVersion(value, path) {
    if (
        typeof value !== 'string'
        || !VERSION_PATTERN.test(value)
        || value.toLowerCase() === 'latest'
    ) {
        fail('invalid_version', path);
    }
    return value;
}

function copyText(value, path) {
    if (typeof value !== 'string' || value.trim().length === 0) fail('non_empty_text_required', path);
    if (Buffer.byteLength(value, 'utf8') > LIMITS.textBytes) fail('text_too_long', path);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
        fail('control_character_rejected', path);
    }
    return value;
}

function copyDate(value, path) {
    if (typeof value !== 'string' || !DATE_PATTERN.test(value)) fail('invalid_date', path);
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
        fail('invalid_date', path);
    }
    return value;
}

function copyHttpsUrl(value, path) {
    if (typeof value !== 'string' || value.length === 0) fail('https_url_required', path);
    if (Buffer.byteLength(value, 'utf8') > LIMITS.urlBytes || /[\u0000-\u001f\u007f]/.test(value)) {
        fail('invalid_url', path);
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail('invalid_url', path);
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        fail('invalid_url', path);
    }
    return value;
}

function copyPositiveInteger(value, path) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) fail('invalid_order', path);
    return value;
}

function copyWeight(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1000) {
        fail('invalid_weight', path);
    }
    return value;
}

function copyImplementationFactor(value, path) {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 1) {
        fail('invalid_implementation_factor', path);
    }
    return value;
}

function copyBoolean(value, path) {
    if (typeof value !== 'boolean') fail('boolean_required', path);
    return value;
}

function copyRightsStatus(value, path) {
    if (!['verified', 'review_required', 'synthetic'].includes(value)) {
        fail('invalid_rights_status', path);
    }
    return value;
}

function copySha256(value, path) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail('invalid_sha256', path);
    return value;
}

function assertEnum(value, allowed, path) {
    if (!allowed.includes(value)) fail('invalid_enum', path);
}

function validateLookupReference(profileId, profileVersion) {
    if (typeof profileId !== 'string' || !ID_PATTERN.test(profileId)) {
        throw new FrameworkProfileLookupError('invalid_framework_profile_reference');
    }
    if (
        typeof profileVersion !== 'string'
        || !VERSION_PATTERN.test(profileVersion)
        || profileVersion.toLowerCase() === 'latest'
    ) {
        throw new FrameworkProfileLookupError('invalid_framework_profile_reference');
    }
}

function digestNormalizedProfile(profile) {
    const payload = cloneValue(profile);
    delete payload.catalogueSha256;
    return crypto.createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function selectFrameworkIdentity(profile) {
    const sourceById = new Map(profile.sources.map((source) => [source.id, source]));
    return deepFreeze({
        ...cloneValue(profile.framework),
        sources: profile.framework.sourceIds.map((sourceId) => cloneValue(sourceById.get(sourceId)))
    });
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function compareProfiles(left, right) {
    return compareAscii(left.profile.id, right.profile.id)
        || compareAscii(left.profile.version, right.profile.version);
}

function compareAscii(left, right) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).map((key) => [key, cloneValue(value[key])]));
    }
    return value;
}

function immutableClone(value) {
    return deepFreeze(cloneValue(value));
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

function fail(code, path) {
    throw new FrameworkProfileValidationError(code, path);
}

module.exports = {
    FRAMEWORK_PROFILE_SCHEMA_VERSION,
    FrameworkProfileLookupError,
    FrameworkProfileValidationError,
    LIMITS,
    calculateFrameworkProfileSha256,
    createFrameworkRegistry,
    publishFrameworkProfile
};
