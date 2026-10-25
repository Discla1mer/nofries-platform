'use strict';

// Synthetic expected DATA result for Blob/controller protocol fixtures. The
// production native test independently reads the actual committed SQL receipt.
const { buildActivationCommands } = require('../../api/shared/customerSignup/customerActivation');
const { dataCodec } = require('../../api/shared/appLifecycle/postgresDashboardBootstrap');
const { consumeEntitlementLimit } = require('../../api/shared/appLifecycle/entitlementDomain');

function activationReservationFixture(approval) {
    const command = buildActivationCommands(approval).reserveMembership, initial = approval.initialState;
    const grant = initial.entitlementState.grants.find(value => value.grantId === command.payload.grantId);
    const usage = consumeEntitlementLimit(initial.entitlementState, initial.tenantAggregate, dataCodec.newUsage(grant), {
        ...approval.scope, ...command.payload, expectedEntitlementRevision: initial.entitlementState.revision,
        expectedFlagRevision: initial.flags.revision, expectedUsageRevision: 0
    }, approval.approvedAt, initial.flags);
    return { operationId: command.operationId, type: 'usage.reserve', reserved: true,
        resultRevisions: { ...command.expectedRevisions, usage: [{ grantId: grant.grantId, revision: usage.revision }] }, usage };
}

module.exports = { activationReservationFixture };
