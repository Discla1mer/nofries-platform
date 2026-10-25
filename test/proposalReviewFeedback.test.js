const fs = require('fs');
const path = require('path');

const activeSalesRuntime = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'shared', 'protectedAssets', 'mssp.js'),
    'utf8'
);

describe('protected proposal review feedback flow', () => {
    test('records apply and subsequent edits atomically with the save, while dismiss uses the feedback route', () => {
        expect(activeSalesRuntime).toContain('/review-feedback`');
        expect(activeSalesRuntime).toContain("await recordProposalReviewFeedback('rejected'");
        expect(activeSalesRuntime).toContain("outcome: app.proposalReview.feedbackNeedsEdited ? 'edited' : 'accepted'");
        expect(activeSalesRuntime).toContain('reviewFeedback: pendingReviewFeedback ? {');
        expect(activeSalesRuntime).toContain('reviewId: app.proposalReview.reviewId');
        expect(activeSalesRuntime).toContain('body: withRevision({');
        expect(activeSalesRuntime).toContain('proposal_review_feedback_stale');
        expect(activeSalesRuntime).toContain('proposal_review_feedback_conflict');
        const saveStart = activeSalesRuntime.indexOf('async function saveProposal');
        const persisted = activeSalesRuntime.indexOf('const result = await api(`/api/sales/proposals/', saveStart);
        const feedback = activeSalesRuntime.indexOf('reviewFeedback: pendingReviewFeedback ? {', persisted);
        expect(persisted).toBeGreaterThan(saveStart);
        expect(feedback).toBeGreaterThan(persisted);
        expect(activeSalesRuntime.indexOf('await recordProposalReviewFeedback(', persisted)).toBe(-1);
    });
});
