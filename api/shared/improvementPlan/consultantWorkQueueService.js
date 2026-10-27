'use strict';

const { isProxy } = require('node:util').types;
const { copy, fields, freeze, instant, digest, uuid } = require('../appLifecycle/dashboardRuntimeRecords');

const MAX_ROWS = 50, MAX_ORGANISATIONS = 5, MAX_PLANS = 10, MAX_OUTPUT_BYTES = 262144;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
class ConsultantWorkQueueError extends Error {
    constructor(code = 'work_queue_unavailable', statusCode = 503) {
        super(code); this.name = 'ConsultantWorkQueueError'; this.code = code; this.statusCode = statusCode;
        delete this.stack; Object.freeze(this);
    }
}
const invalid = () => { throw new ConsultantWorkQueueError('work_queue_input_invalid', 400); };
const changed = () => { throw new ConsultantWorkQueueError('work_queue_changed', 409); };
const nullableId = value => value === null || typeof value === 'string' && ID.test(value);
function normaliseConsultantWorkQueuePage(input) {
    try {
        const value = fields(copy(input, 4096), ['limit', 'cursor']);
        if (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_ROWS ||
            value.cursor !== null && (typeof value.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(value.cursor))) invalid();
        if (value.cursor !== null) decodeCursor(value.cursor);
        return freeze(value);
    } catch { invalid(); }
}
function decodeCursor(token, generation) {
    if (token === null) return { version: 1, generation, afterBindingId: null, bindingId: null,
        afterPlanId: null, planId: null, planRevision: null, offset: 0 };
    try {
        const value = fields(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
            ['version', 'generation', 'afterBindingId', 'bindingId', 'afterPlanId', 'planId', 'planRevision', 'offset']);
        if (Buffer.from(JSON.stringify(value)).toString('base64url') !== token || value.version !== 1) invalid();
        digest(value.generation);
        if (generation !== undefined && value.generation !== generation) changed();
        if (value.afterBindingId !== null) uuid(value.afterBindingId);
        if (value.bindingId !== null) uuid(value.bindingId);
        if (!nullableId(value.afterPlanId) || !nullableId(value.planId) || !Number.isSafeInteger(value.offset) ||
            value.offset < 0 || value.offset >= 4096) invalid();
        if (value.bindingId === null && (value.afterPlanId !== null || value.planId !== null || value.offset !== 0)) invalid();
        if (value.planId === null ? value.planRevision !== null || value.offset !== 0
            : !Number.isSafeInteger(value.planRevision) || value.planRevision < 0) invalid();
        return value;
    } catch (error) { if (error instanceof ConsultantWorkQueueError) throw error; invalid(); }
}
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function queueRow(binding, plan, day) {
    return action => ({ bindingId: binding.bindingId, organisationLabel: binding.organisationLabel,
        planId: plan.scope.planId, planRevision: plan.planRevision, actionId: action.actionId,
        suggestedAction: action.rationale.suggestedAction, status: action.status,
        assigned: action.ownerSubjectKey !== null, ownerEligibility: 'not_checked', dueDate: action.dueDate,
        isOverdue: action.status !== 'completed' && action.dueDate !== null && action.dueDate < day,
        blockedReason: action.blockedReason,
        source: { assessmentId: plan.source.assessmentId, assessmentRevision: plan.source.assessmentRevision } });
}
function knownUnavailable(error) {
    if (isProxy(error)) return false;
    return error && typeof error === 'object' && [403, 404, 503].includes(Object.getOwnPropertyDescriptor(error, 'statusCode')?.value);
}

// The ports are server-owned, request-bound capabilities. A cursor is an
// untrusted seek position, never authority: every page enumerates and authorises
// every target afresh. It contains no tenant, subject or session identity.
function createConsultantWorkQueueService(options) {
    let ports, generation;
    try {
        fields(options, ['generation', 'clock', 'listBindings', 'plans', 'list', 'finish', 'assertDisclosure']);
        generation = digest(options.generation);
        for (const name of ['clock', 'listBindings', 'plans', 'list', 'finish', 'assertDisclosure']) {
            if (typeof options[name] !== 'function' || isProxy(options[name])) invalid();
        }
        ports = Object.freeze({ ...options });
    } catch { invalid(); }
    return Object.freeze({ async read(input) {
        const page = normaliseConsultantWorkQueuePage(input), cursor = decodeCursor(page.cursor, generation);
        const asOf = instant(ports.clock()), rows = [], organisations = [];
        let planReads = 0, visited = 0, unavailableOrganisations = 0, complete = false, bytes = 0;
        while (rows.length < page.limit && visited < MAX_ORGANISATIONS && planReads < MAX_PLANS) {
            const directory = await ports.listBindings({ afterBindingId: cursor.afterBindingId, limit: 1 });
            if (!directory.bindings.length) { complete = true; break; }
            const binding = directory.bindings[0];
            if (cursor.bindingId !== null && cursor.bindingId !== binding.bindingId) changed();
            cursor.bindingId = binding.bindingId; visited++;
            let group = null, finishedBinding = false;
            try {
                while (rows.length < page.limit && planReads < MAX_PLANS) {
                    const plans = await ports.plans(binding.bindingId, { limit: 1, afterPlanId: cursor.afterPlanId });
                    if (!group) {
                        group = { bindingId: binding.bindingId, organisationLabel: binding.organisationLabel,
                            state: 'partial', plansChecked: 0 };
                        organisations.push(group);
                    }
                    if (!plans.plans.length) {
                        if (cursor.planId !== null) changed();
                        finishedBinding = true; break;
                    }
                    const head = plans.plans[0];
                    if (cursor.planId !== null && cursor.planId !== head.planId) changed();
                    const plan = await ports.list(binding.bindingId, { planId: head.planId,
                        filters: { status: 'all', owner: 'all', overdueOnly: false } });
                    planReads++; group.plansChecked++;
                    if (plan.scope.planId !== head.planId || plan.actions.length > 4096) throw new ConsultantWorkQueueError();
                    if (cursor.planId !== null && cursor.planRevision !== plan.planRevision) changed();
                    if (cursor.offset > plan.actions.length) changed();
                    const project = queueRow(binding, plan, asOf.slice(0, 10));
                    while (cursor.offset < plan.actions.length && rows.length < page.limit) {
                        const row = project(plan.actions[cursor.offset]), size = Buffer.byteLength(JSON.stringify(row));
                        if (size > MAX_OUTPUT_BYTES) throw new ConsultantWorkQueueError();
                        if (bytes + size > MAX_OUTPUT_BYTES) break;
                        rows.push(row); bytes += size; cursor.offset++;
                    }
                    if (cursor.offset < plan.actions.length) {
                        cursor.planId = head.planId; cursor.planRevision = plan.planRevision;
                        // Size and row budgets both return a continuation; do
                        // not repeatedly read the same large retained plan.
                        break;
                    }
                    cursor.afterPlanId = head.planId; cursor.planId = null; cursor.planRevision = null; cursor.offset = 0;
                    if (plans.nextAfterPlanId === null) { finishedBinding = true; break; }
                }
            } catch (error) {
                if (error instanceof ConsultantWorkQueueError || !knownUnavailable(error)) throw error;
                // A failed target contributes neither its label nor any
                // prepared rows. Final authority still governs the whole page.
                for (let i = rows.length - 1; i >= 0; i--) if (rows[i].bindingId === binding.bindingId) rows.splice(i, 1);
                if (group) organisations.splice(organisations.indexOf(group), 1);
                unavailableOrganisations++; finishedBinding = true;
            }
            if (!finishedBinding) break;
            if (group && organisations.includes(group)) group.state = 'checked';
            cursor.afterBindingId = binding.bindingId; cursor.bindingId = null; cursor.afterPlanId = null;
            cursor.planId = null; cursor.planRevision = null; cursor.offset = 0;
            if (directory.nextAfterBindingId === null) { complete = true; break; }
        }
        // No payload escapes until every successfully read target, the original
        // subject/session and the request lifetime survive a final authority read.
        const result = freeze({ schemaVersion: 1, asOf, dueDateBasis: 'UTC_calendar_day', rows, organisations,
            coverage: { basis: 'current_page', checkedOrganisations: organisations.filter(row => row.state === 'checked').length,
                partialOrganisations: organisations.filter(row => row.state === 'partial').length,
                unavailableOrganisations, complete }, nextCursor: complete ? null : encodeCursor(cursor) });
        await ports.finish();
        ports.assertDisclosure();
        return result;
    } });
}
module.exports = Object.freeze({ ConsultantWorkQueueError, normaliseConsultantWorkQueuePage, createConsultantWorkQueueService });
