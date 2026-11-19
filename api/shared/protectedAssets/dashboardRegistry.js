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
        ['fractional_advisory', 'Fractional CIO, CTO and CISO', 'Direction and decisions within an agreed assignment.'],
        ['managed_endpoint', 'IRMM / RMM monitoring', 'Monitoring for explicitly covered devices and sites.'],
        ['endpoint_security', 'MDR / endpoint security', 'Security coverage and escalation must be verified separately.'],
        ['tier1_support', 'Tier 1 support', 'Support hours and response commitments follow the signed scope.'],
        ['managed_it_core', 'Managed IT', 'A service package, not automatic access to its components.'],
        ['work_file_backup', 'Work-file backup', 'Recovery scope and protected data must be agreed.'],
        ['microsoft_365_admin', 'Microsoft 365 administration', 'Your tenant and licences remain customer-owned.'],
        ['google_workspace_admin', 'Google Workspace administration', 'Your tenant and licences remain customer-owned.'],
        ['supplier_coordination', 'Supplier coordination', 'Supplier actions require explicit customer authority.'],
        ['monthly_proof', 'Monthly service proof', 'Issued service records require verified source evidence.'],
        ['customer_onboarding', 'Customer onboarding', 'Activation follows an approved onboarding plan.'],
        ['ai_service_desk', 'AI-assisted service desk', 'Assistance does not authorise supplier actions.']
    ].map(function (row) { return Object.freeze({ key: row[0], label: row[1], description: row[2] }); }));

    const paidFrameworks = Object.freeze([
        Object.freeze({ moduleId: 'cyber_security', profileId: 'nf-nist-csf-2-0-core', version: '2026-09-08.1',
            label: 'NIST CSF 2.0', description: 'Review how your organisation manages cyber risk across the six NIST functions and see where work is needed.' }),
        Object.freeze({ moduleId: 'cyber_security', profileId: 'nf-iso-27001-2022-readiness', version: '2026-11-19.1',
            label: 'ISO 27001 readiness self-assessment', description: 'Review how you manage information security, record which controls apply and identify gaps to work on.' })
    ]);
    // Public SRI pins for the two fixed, separately admitted package files.
    const rendererIntegrity = Object.freeze({
        questionnaire: 'sha256-8QfOBBBl9FdFuTmqVEvMmhYHPR5Zx7QbsQuA+umd+wg=',
        results: 'sha256-ND6K2BYrIb2BoGu9l0omvezKzmRpZJ/T/rP6CsdyCgY='
    });
    function rendererSelection(generation, ref, name, nonce) {
        return JSON.stringify(['paid-renderer-v2', nonce, generation, ref.moduleId, ref.profileId, ref.version, name, rendererIntegrity[name]]);
    }
    function sameFramework(left, right) {
        return left.moduleId === right.moduleId && left.profileId === right.profileId && left.version === right.version;
    }

    function resolveRoute(route, permitted) {
        const key = typeof route === 'string' ? route.replace(/^#/, '') : '';
        const matched = modules.find(function (item) { return item.route === (key === 'plan' ? 'improvement-plan' : key); });
        return matched && Array.isArray(permitted) && permitted.includes(matched.key) ? matched : null;
    }
    return Object.freeze({ schemaVersion: 1, modules: modules, services: services, paidFrameworks: paidFrameworks, sameFramework: sameFramework,
        rendererIntegrity: rendererIntegrity, rendererSelection: rendererSelection, groups: Object.freeze(['Home', 'Assess', 'Plan', 'Proof', 'More']), resolveRoute: resolveRoute });
}));
