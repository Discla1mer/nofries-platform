'use strict';

const { validateAcceptanceReceipt } = require('./invitationAcceptance');
const { isProxy } = require('node:util').types;

const RETENTION_POLICY_ID = 'gov-007-issued-decision-proof-7y-v1';

class SignupAcceptanceJournalError extends Error {
    constructor(code = 'signup_acceptance_journal_unavailable', statusCode = 503) {
        super(code);
        this.name = 'SignupAcceptanceJournalError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

function createPostgresSignupAcceptanceJournal(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Reflect.ownKeys(options).length !== 1 || !Object.hasOwn(options, 'database') ||
        typeof options.database?.withTenantTransaction !== 'function') {
        throw new SignupAcceptanceJournalError('signup_acceptance_journal_configuration_invalid');
    }
    const database = options.database;
    return Object.freeze({
        async readForInvitation(input) {
            let scope;
            try {
                scope = exactData(input, ['tenantId', 'organisationId', 'invitationId']);
                for (const value of Object.values(scope)) {
                    if (typeof value !== 'string' || !value || value.length > 180 ||
                        value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
                }
            } catch (_) { throw new SignupAcceptanceJournalError('signup_acceptance_reference_invalid', 400); }
            try {
                return await database.withTenantTransaction(scope.tenantId, async tx => {
                    const result = await tx.query(
                        `SELECT payload FROM nofries.signup_acceptance_receipts
                         WHERE tenant_id=$1 AND organisation_id=$2 AND invitation_id=$3`,
                        [scope.tenantId, scope.organisationId, scope.invitationId]
                    );
                    if (!Array.isArray(result?.rows) || result.rows.length > 1) {
                        throw new SignupAcceptanceJournalError('signup_acceptance_journal_record_invalid');
                    }
                    if (result.rows.length === 0) return null;
                    const payload = JSON.parse(canonical(result.rows[0]?.payload));
                    const receipt = validateAcceptanceReceipt(payload.receipt);
                    for (const key of ['tenantId', 'organisationId', 'invitationId']) {
                        if (receipt[key] !== scope[key]) {
                            throw new SignupAcceptanceJournalError('signup_acceptance_journal_conflict', 409);
                        }
                    }
                    return receipt;
                });
            } catch (error) {
                if (error instanceof SignupAcceptanceJournalError) throw error;
                throw new SignupAcceptanceJournalError();
            }
        },
        async persist(input) {
            let receipt;
            try { receipt = validateAcceptanceReceipt(input); }
            catch (_) { throw new SignupAcceptanceJournalError('signup_acceptance_receipt_invalid', 400); }
            const payload = Object.freeze({ schemaVersion: 1, retentionPolicyId: RETENTION_POLICY_ID,
                deleteAfter: addUtcYears(receipt.acceptedAt, 7), receipt });
            try {
                return await database.withTenantTransaction(receipt.tenantId, async tx => {
                    const inserted = await tx.query(
                        `INSERT INTO nofries.signup_acceptance_receipts
                            (tenant_id, organisation_id, receipt_id, invitation_id, subject_key,
                             terms_version, terms_digest, schedule_id, schedule_digest, accepted_at,
                             retention_policy_id, delete_after, payload)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
                         ON CONFLICT (tenant_id, organisation_id, receipt_id) DO NOTHING
                         RETURNING payload`,
                        [receipt.tenantId, receipt.organisationId, receipt.receiptId, receipt.invitationId,
                            receipt.subjectKey, receipt.termsVersion, receipt.termsDigest,
                            receipt.scheduleId ?? null, receipt.scheduleDigest ?? null, receipt.acceptedAt,
                            RETENTION_POLICY_ID, payload.deleteAfter, JSON.stringify(payload)]
                    );
                    let stored = inserted.rows[0]?.payload;
                    if (!stored) {
                        const existing = await tx.query(
                            `SELECT payload FROM nofries.signup_acceptance_receipts
                             WHERE tenant_id=$1 AND organisation_id=$2 AND receipt_id=$3`,
                            [receipt.tenantId, receipt.organisationId, receipt.receiptId]
                        );
                        stored = existing.rows[0]?.payload;
                    }
                    if (canonical(stored) !== canonical(payload)) {
                        throw new SignupAcceptanceJournalError('signup_acceptance_journal_conflict', 409);
                    }
                    return receipt;
                });
            } catch (error) {
                if (error instanceof SignupAcceptanceJournalError) throw error;
                throw new SignupAcceptanceJournalError();
            }
        }
    });
}

function addUtcYears(epochMs, years) {
    const date = new Date(epochMs);
    if (!Number.isSafeInteger(epochMs) || Number.isNaN(date.valueOf())) {
        throw new SignupAcceptanceJournalError('signup_acceptance_receipt_invalid', 400);
    }
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + years);
    date.setUTCMonth(date.getUTCMonth() + 1, 0);
    const lastDay = date.getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    const result = date.valueOf();
    if (!Number.isSafeInteger(result)) throw new SignupAcceptanceJournalError('signup_acceptance_receipt_invalid', 400);
    return result;
}

function canonical(value) {
    try {
        const snapshot = exactData(value, ['schemaVersion', 'retentionPolicyId', 'deleteAfter', 'receipt']);
        if (snapshot.schemaVersion !== 1 || snapshot.retentionPolicyId !== RETENTION_POLICY_ID ||
            !Number.isSafeInteger(snapshot.deleteAfter)) throw new Error();
        const receipt = validateAcceptanceReceipt(snapshot.receipt);
        const expected = { schemaVersion: 1, retentionPolicyId: RETENTION_POLICY_ID,
            deleteAfter: addUtcYears(receipt.acceptedAt, 7), receipt };
        if (snapshot.deleteAfter !== expected.deleteAfter) throw new Error();
        return JSON.stringify(expected);
    } catch (error) {
        if (error instanceof SignupAcceptanceJournalError) throw error;
        throw new SignupAcceptanceJournalError('signup_acceptance_journal_record_invalid');
    }
}

function exactData(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value) ||
        ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new Error();
    const own = Reflect.ownKeys(value);
    if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error();
    const result = {};
    for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) throw new Error();
        result[key] = descriptor.value;
    }
    return result;
}

module.exports = Object.freeze({ RETENTION_POLICY_ID, SignupAcceptanceJournalError,
    createPostgresSignupAcceptanceJournal });
