# A dashboard that stays useful as information changes

The goal is a continuing view of an organisation's IT position: what is known,
what needs attention, what changed and what to do next. A questionnaire is one
input to that view. The dashboard should remain useful after the first submission.

## First slice: saved work stays visible

Related UX work: [#151](https://github.com/Discla1mer/nofries-platform/issues/151).
This change builds on autosave (#179), saved-assessment comparison (#170) and the
clearer results view (#181). It does not replace those changes.

- Overview shows the latest save for up to three loaded assessments, newest first,
  with their scope, saved/submitted time and a useful next action.
- A draft can be continued without hiding or rewriting a submitted baseline.
- Returning to the tab refreshes the loaded assessment pages and selected record
  after the host's existing final session check. Each read uses the authorised
  client. Returning from the questionnaire already remounts Overview with fresh reads.
- An unchanged response keeps the existing view, disclosures and focus. A changed
  response updates the saved work and selected record. A denied read clears it;
  other failures hide results and provide Retry. Refresh remains available manually.
- The prominent “Answers saved/submitted” date is the saved record date, labelled
  as self-reported assessment answers. “Saved assessment data refreshed” is the browser's
  successful read time, not the time anyone
  observed a control or a promise of continuous monitoring. No polling is added.
- Results remain the validated server-calculated submitted results. Draft saves
  update saved progress only. No score is calculated in the browser.

Recent saved work is not an audit trail: the list contains one latest summary per
loaded assessment. Pagination is explicit; an unseen page may contain a newer
record. Selecting an older baseline stays intentional, even when newer work arrives.

## Next bounded slices, not implemented here

1. **Current-state contract.** Define an explicit organisation/scope selection and
   accepted source precedence rather than calling the first assessment “current”.
   Retain source versions, observation times and previous states. Reuse existing
   revision and evaluator contracts instead of reopening immutable submissions.
2. **Update an input.** Make a manual change, save it through the authorised service,
   then show the accepted result and the reason for any change. Distinguish saved,
   waiting for calculation, failed and conflicting changes. A task completion or
   a new document must not automatically improve implementation or evidence scores.
3. **Attention and progress.** Reuse existing actions and submitted comparisons.
   Explain ordering; do not label profile order a risk ranking. Compare compatible
   scopes and revisions, and preserve earlier issued snapshots.
4. **Additional sources.** Show connected, waiting for setup, stale, failed and
   unavailable states only from verified source readiness. Define and measure
   refresh latency and source-specific freshness rules. Manual updates must work
   without integrations. Inventory, device health and provider feeds are not
   supplied by this slice.

Before calling the broader view live, test save-to-visible-update latency,
concurrent sessions, failed/uncertain saves, source conflicts, missing/unknown/N/A
inputs, organisation switching, revoked access and earlier-state reproduction.
The visual direction is cream, mustard and serif with clear sections for current
information, attention, recent changes and progress. Layout must follow available
data, not fill those sections with invented health scores or integrations.
