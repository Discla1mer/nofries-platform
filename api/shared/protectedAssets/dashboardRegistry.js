(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NoFriesDashboardRegistry = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // Display metadata only. Server membership/permission/entitlement policy owns access.
    const modules = Object.freeze([
        ['overview', 'Overview', 'overview', 'Home', 'overview.read', 'OV'],
        ['ai_governance', 'AI Governance and Strategy', 'ai-governance', 'Assess', 'assessment.read', 'AI'],
        ['cyber_security', 'Cyber Security', 'cyber-security', 'Assess', 'assessment.read', 'CS'],
        ['it_optimisation', 'IT Optimisation', 'it-optimisation', 'Assess', 'assessment.read', 'IT'],
        ['improvement_plan', 'Improvement Plan', 'improvement-plan', 'Plan', 'improvement.read', 'IP'],
        ['evidence', 'Evidence', 'evidence', 'Proof', 'evidence.read', 'EV'],
        ['board_reports', 'Board Reports', 'board-reports', 'Proof', 'report.read_issued', 'BR'],
        ['services', 'Services', 'services', 'More', 'services.read', 'SV']
    ].map(function (row, order) {
        return Object.freeze({ key: row[0], label: row[1], route: row[2], group: row[3],
            permission: row[4], icon: row[5], order: order });
    }));
    const services = Object.freeze([
        ['fractional_advisory', 'IT and security advice', 'Part-time technology and security leadership to help you choose what to improve first.'],
        ['managed_endpoint', 'Device monitoring and maintenance', 'Help keep agreed computers and devices updated and spot problems early.'],
        ['endpoint_security', 'Threat monitoring and response', 'Help detect and respond to suspicious activity on agreed computers and devices.'],
        ['tier1_support', 'Everyday IT support', 'Help with everyday computer and account problems, during agreed support hours.'],
        ['managed_it_core', 'Managed IT', 'An agreed package of IT support and maintenance; its individual services must be confirmed.'],
        ['work_file_backup', 'Work-file backup', 'Help protect copies of your business files and check they can be restored.'],
        ['microsoft_365_admin', 'Microsoft 365 administration', 'Help manage your Microsoft work accounts and settings. Your organisation keeps ownership of its accounts and licences.'],
        ['google_workspace_admin', 'Google Workspace administration', 'Help manage your Google work accounts and settings. Your organisation keeps ownership of its accounts and licences.'],
        ['supplier_coordination', 'Supplier coordination', 'Help work with your IT suppliers, with your permission before supplier actions.'],
        ['monthly_proof', 'Monthly service reports', 'A record of completed work, backed by checked evidence.'],
        ['customer_onboarding', 'Getting set up', 'Help plan and set up the services you have agreed to use.'],
        ['ai_service_desk', 'AI-assisted help desk', 'Help describe IT problems and find the next step. Supplier actions still need your permission.']
    ].map(function (row) { return Object.freeze({ key: row[0], label: row[1], description: row[2] }); }));

    function resolveRoute(route, permitted) {
        const key = typeof route === 'string' ? route.replace(/^#/, '') : '';
        const matched = modules.find(function (item) { return item.route === key; });
        return matched && Array.isArray(permitted) && permitted.includes(matched.key) ? matched : null;
    }
    return Object.freeze({ schemaVersion: 1, modules: modules, services: services,
        groups: Object.freeze(['Home', 'Assess', 'Plan', 'Proof', 'More']), resolveRoute: resolveRoute });
}));
