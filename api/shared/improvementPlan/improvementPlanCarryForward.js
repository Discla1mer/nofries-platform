'use strict';

// Pure planning for a reassessment. Matches each new gap to the previous plan's
// action for the same assessment question (itemId), and lists ordinary
// assign/start/block commands that re-apply its owner, due date and open-work
// status. Completion is never carried: a question that is still a gap needs the
// work again, so it returns as open with its owner and due date. Previous
// actions whose question is no longer a gap are left in the previous plan.
function planCarryForward(previousPlan, nextPlan) {
    if (!canCarryFrom(previousPlan, nextPlan)) return [];
    const prior = new Map(previousPlan.actions.map(action => [action.itemId, action]));
    return nextPlan.actions.flatMap(action => {
        const source = prior.get(action.itemId);
        if (!source || !source.dueDate || action.status !== 'open') return [];
        const labelled = Object.hasOwn(source, 'ownerLabel');
        if (!labelled && source.ownerSubjectKey === null) return [];
        const owner = labelled ? { ownerLabel: source.ownerLabel } : { ownerSubjectKey: source.ownerSubjectKey };
        const steps = [{ type: 'assign', payload: { ...owner, dueDate: source.dueDate } }];
        if (['in_progress', 'blocked'].includes(source.status)) steps.push({ type: 'start', payload: {} });
        if (source.status === 'blocked') steps.push({ type: 'block', payload: { reason: source.blockedReason } });
        return [{ actionId: action.actionId, itemId: action.itemId,
            ownerSubjectKey: labelled ? null : source.ownerSubjectKey, steps }];
    });
}

// Only carry from an earlier assessment of the same module, so a plan made
// later for an older assessment never inherits from a newer one.
function canCarryFrom(previousPlan, nextPlan) {
    const before = previousPlan?.source?.provenance, after = nextPlan?.source?.provenance;
    return !!before && !!after && before.moduleId === after.moduleId &&
        before.assessmentId !== after.assessmentId && before.scoreAsOf <= after.scoreAsOf;
}

// Readable, deterministic provenance: the previous plan's head row digest
// identifies the exact retained revision the values were carried from.
function carryOperationId(sourcePayloadSha256, revision) {
    return `carry:${sourcePayloadSha256}:${revision}`;
}

// Applies one carried action's steps in order. applyStep(step, state, head)
// returns { state, record }. If the assign is rejected nothing is carried. If
// a later start/block is rejected (a value today's rules no longer accept), the
// action is still carried as assigned: owner and due date kept, status open.
// Errors that are not rejections (e.g. database errors) propagate.
function applyCarriedSteps(steps, state, head, applyStep, isRejection) {
    const records = [];
    let assigned = null;
    for (const step of steps) {
        let applied;
        try { applied = applyStep(step, state, head); }
        catch (error) {
            if (!isRejection(error)) throw error;
            return assigned;
        }
        state = applied.state; head = applied.record; records.push(head);
        if (records.length === 1 && step.type === 'assign') assigned = { state, head, records: [head] };
    }
    return { state, head, records };
}

module.exports = Object.freeze({ planCarryForward, canCarryFrom, carryOperationId, applyCarriedSteps });
