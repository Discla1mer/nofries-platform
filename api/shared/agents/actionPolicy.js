const ACTION_PERMISSION = Object.freeze({
    AUTONOMOUS_READ: 'autonomous_read',
    AUTONOMOUS_RECORD: 'autonomous_record',
    PRE_AUTHORISED_AUTOMATION: 'pre_authorised_automation',
    HUMAN_APPROVAL_REQUIRED: 'human_approval_required'
});

const ACTION_PERMISSION_VALUES = Object.freeze(Object.values(ACTION_PERMISSION));

function assertKnownPermission(permission) {
    if (!ACTION_PERMISSION_VALUES.includes(permission)) {
        const error = new Error('The agent action has no recognised permission class');
        error.statusCode = 403;
        error.details = { code: 'action_permission_unclassified' };
        throw error;
    }
    return permission;
}

function requiresHumanApproval(permission) {
    return assertKnownPermission(permission) === ACTION_PERMISSION.HUMAN_APPROVAL_REQUIRED;
}

module.exports = {
    ACTION_PERMISSION,
    ACTION_PERMISSION_VALUES,
    assertKnownPermission,
    requiresHumanApproval
};
