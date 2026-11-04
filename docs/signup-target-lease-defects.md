# Signup target lease defects (#75)

Stack: #55 → #57 → #61 → this fix. Reset stays **UNWIRED and disabled**.
Only the dormant Azure binding and its baseline tests are carried from #47
(`685636aea724491bb4eed2d1c974e16a709f0948`). The import assertion expects
zero runtime callers on this stack; no admin adapter or route is introduced.

The test-first commit reproduces both #20 review findings: 7 original tests
pass, while stale-holder implicit cleanup, stale-holder explicit completion,
and failed completion followed by retention each allow an ordinary conditional
account write that must be refused (3 failures).

The fix conditionally deletes the fence using the holder's ETag **before**
releasing either target lease. This storage operation is the ownership decision;
a read/check followed by unconditional release would leave a takeover race.
A failed or unacknowledged deletion releases no leases, and completion is never
retried by automatic cleanup. After acknowledged deletion the handle is terminal,
even if releasing a lease subsequently fails.

Unknown deletion acknowledgement or failed release can leave orphaned infinite
leases after the marker is gone. Do not infer idle from a missing target marker,
break leases, or automatically retry/resume. The mandatory #61 common writer
fence retains its intent/lease on failed or uncertain completion; operator
recovery must reconcile versioned fence evidence and actual target leases under
the existing drainage, versioning, adoption and source-binding safeguards.
Target leases alone never protect creation of an absent record.

Before the admin reset is considered, #47 must adopt this corrected binding
while preserving its disabled reset and common-fence wrapper. The common writer
implementation/digest inputs are unchanged here. This synthetic storage-model
evidence is not live Azure recovery qualification or activation permission.

Run the adversarial suite:

```sh
npm test -- --runInBand test/azureEmptySignupResetBinding.test.js test/signupFenceReconciliation.test.js test/emptySignupReset.test.js test/signupWriterFencePending.test.js test/signupResetWriterParticipation.test.js test/retainedWriterRecoveryPlan.test.js
```

The added tests use explicit promise gates, not sleeps: both stale cleanup
paths, takeover while deletion is in flight, failed deletion plus retain and
same-operation recovery, lost acknowledgement before/after deletion, and a
post-deletion release failure. Both account and authority writers are checked.
