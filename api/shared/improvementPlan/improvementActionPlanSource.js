'use strict';

const { fields } = require('../appLifecycle/dashboardRuntimeRecords');
const { createImprovementPlanService, ImprovementPlanServiceError } = require('./improvementPlanService');
const { createPostgresImprovementPlanRepository } = require('./postgresImprovementPlanRepository');
const { createImprovementEvidenceLinkService } = require('./improvementEvidenceLinkService');
const { createPostgresImprovementEvidenceLinkRepository } = require('./postgresImprovementEvidenceLinkRepository');
const { createImprovementActionListService } = require('./improvementActionListService');
const { createPostgresImprovementActionListRepository } = require('./postgresImprovementActionListRepository');
const { createImprovementActionEditorSource } = require('./improvementActionEditorSource');
const { projectImprovementActionPlanPresentation } = require('./improvementActionPlanPresentation');

// Explicit source ports only; the request host supplies the genuine lifetime.
// Each method settles its own transaction. A subsequent evidence selection must
// name the list's exact plan revision; no cross-call atomic snapshot is promised.
// New commands audit within their existing transaction. The host must pair the
// database/audit ports and enforce current authority through settlement.
function createImprovementActionPlanSource(options) {
    let database, clock, audit, requestContext;
    try { ({ database, clock, audit, requestContext } = fields(options, ['database', 'clock', 'audit', 'requestContext'])); }
    catch { throw new ImprovementPlanServiceError('improvement_input_invalid', 400); }
    const plans = createImprovementPlanService({ requestContext,
        repository: createPostgresImprovementPlanRepository({ database, clock, audit }) });
    const list = createImprovementActionListService({ requestContext,
        repository: createPostgresImprovementActionListRepository({ database, clock, audit }) });
    const evidence = createImprovementEvidenceLinkService({ requestContext,
        repository: createPostgresImprovementEvidenceLinkRepository({ database, clock, audit }) });
    const editor = createImprovementActionEditorSource({ database, clock, audit, requestContext });
    return Object.freeze({ plans: list.plans, list: list.list, editor: editor.editor, execute: plans.execute, resolveEvidence: evidence.resolve,
        async view(request, input) { return projectImprovementActionPlanPresentation(await list.list(request, input)); } });
}
module.exports = Object.freeze({ createImprovementActionPlanSource });
