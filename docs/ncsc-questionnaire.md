# NCSC questionnaire source composition

NCSC-005 adds a questionnaire for the accepted NCSC-aligned foundational gap
screen. An explicitly composed synthetic dashboard can start an assessment,
resume saved answers, clear an answer, save progress and submit through the
NCSC-004 client. The declaration is immutable after creation. Submission seals
the answers; the form displays only acknowledged submitted answers and the
submitted revision and time. Any divergent local draft is retained in a separate
explicitly unsubmitted section. NCSC-006 now presents the saved server evaluation, with domain/control drill-down, in the same protected component. See `docs/ncsc-results.md`.

This is a source component. The normal dashboard projection still marks Cyber
planned, and the existing dashboard service still serves its existing bundle.
There is no new route, public asset, database migration, profile endpoint or
runtime installation. POR-010 owns authenticated composition, verified sessions,
CSRF/origin guard, protected delivery and the eventual readiness projection.
An editable presentation hint does not grant authority; the API checks current
access for every operation.

## Explicit interfaces

`createNcscQuestionnaireMetadata()` in `api/shared/ncscQuestionnaireMetadata.js`
projects frozen display data from the verified accepted factory. Its six-field
profile reference, prompts, ordering, guidance, allowed answers, attribution,
claim, limitations and licence come from that source. Weights, implementation
factors and internal source specification records are omitted.

`NoFriesNcscAssessmentClient.createClient({ metadata, fetch })` constructs only
fixed same-origin NCSC routes. Its methods are:

- `list({ limit, afterAssessmentId, signal })`, with defaults 50 and null.
- `read(assessmentId, { signal })`.
- `create(command, { signal })`, `save(command, { signal })` and
  `submit(command, { signal })`, using a complete normalized command containing
  assessmentId, action, idempotencyKey, expectedRevision and payload.
- `normaliseCommand(command)` validates and freezes the normalized command.
  `commandByteLength(command)` sizes a bounded planning candidate, including one
  that exceeds the send limit.

Methods return validated API envelopes and throw a fixed error with `code`,
`statusCode` and `ambiguous`. The client creates no operation keys and performs
no automatic retry. Unknown transport/status/body results and every mutation
503 are unconfirmed. No arbitrary server error message or HTML is rendered.
Responses have a separate 512 KiB bound. Submission evaluation is a bounded, provenance-bound server result. The questionnaire retains only the validated presentation projection; the server remains responsible for arithmetic and output-hash verification.
Both client and renderer compare the six required profile-reference values
without depending on JSON key order. Missing, extra or changed fields are
rejected; a valid reference reordered by PostgreSQL JSONB remains valid on
ordinary list/detail responses and exact receipt replay.

`NoFriesNcscQuestionnaire.mount(root, { metadata, client, presentationMode,
window, createId })` returns `{ requestLeave, destroy }`. Only literal
`presentationMode: 'editable'` offers write controls. `window` is optional;
`createId` is an optional deterministic test seam that must return an ASCII
UUID. Normal use requires `crypto.randomUUID()`.

The shell accepts `options.mountCyber(childRoot, { generation })`. It calls this
adapter only for a permitted Cyber module explicitly marked ready. The adapter
returns the questionnaire controller. The opaque generation belongs to this
shell mount; a context change requires a fresh mount even when organisation and
assessment IDs collide. No module imports or URLs are chosen from user input.

`requestLeave(commit?)` returns a promise for a managed leave decision. The first
request captures its trusted callback; later requests share the decision and
cannot replace its target. The same owner coordinates assessment and module
navigation. `destroy()` is idempotent, aborts requests and invalidates every
continuation. An obsolete controller cannot clear a replacement.

## Drafts, validation and saves

Drafts exist only in mount memory. Refresh resumes acknowledged server progress;
there is no localStorage, sessionStorage, offline cache or record-bearing URL.
A lost in-memory create command cannot be silently reconstructed with a new ID.
Only acknowledged progress is labelled saved.

The form uses native labelled controls, a fieldset and legend, a question index,
Previous/Next, guidance details and a polite saved-status region. Managed leave
uses a native modal dialog and backdrop, including native cancel handling. If
that modal facility cannot open, navigation is refused with the draft retained. Unknown is an
explicit answer. N/A needs a rationale and remains a pending claim. Clear answer
sends null option and null rationale. Counts describe completion, not a score.

Declaration and rationale validation matches the final NCSC-004 normalizer:
nonblank, at most 4,000 JavaScript UTF-16 units, no NUL and no unpaired surrogate.
Valid pairs, other controls, combining and multibyte text and literal escape
sequences are preserved exactly. The renderer never strips, normalizes or
truncates an invalid draft. Linked errors reveal and focus the relevant question
without changing the module fragment. Typing updates the existing textarea;
async rendering retains its current text, focus and selection where applicable.

One Save action captures dirty answers in stable item-ID order. It greedily
packs whole responses into commands of at most 65,536 UTF-8 JSON bytes,
including the route-derived assessment ID and action. Planning uses fixed-length
UUIDs and the three-digit revision bound. It preflights all batches against
`127 - savedRevision` before the first write. Revision 128 remains reserved for
submission. A field is never truncated to make a request fit.

Batches run serially. Acknowledgments clean only the captured answer generation;
newer typing stays dirty. An error stops the queue and preserves acknowledged,
uncertain and unsent work separately. Submit and leave-Save drain valid dirty
batches, then check for newer edits before proceeding. Creation scope is
read-only during its pending create, and answer editing is disabled during a
pending submit. Save requests still permit newer answer generations. A blank N/A draft blocks
submission even if the preceding server version was complete.

Every uncertain mutation retains its exact immutable envelope and key for an
explicit retry, including `ncsc_unavailable` 503. A failure cannot prove that no
commit occurred. After successful reconciliation the controller reads current
detail before allowing later writes, keeps revisions monotonic and requires an
explicit choice when saved and local answers conflict. A failed current read
keeps writes blocked. It never silently reapplies a changed intent under an old
key or treats the original retry result as the latest server state.

Discard applies only to unsent drafts. Managed navigation cannot abandon a
running or uncertain operation. Forced authentication/tenant replacement or
access denial clears immediately, without waiting for a dialog or network reply.
Every async list/read/save/retry/leave continuation checks the current mount and
assessment generation, including reads whose response arrives after typing.

## Navigation and evidence boundaries

Without an adapter, shell navigation retains the existing immediate behavior.
The composed path shares Save/Discard/Stay decisions. The shell tags owned
same-document entries while preserving unrelated history state. Back/Forward
cancellation returns the cursor with `history.go`; it does not overwrite the
traversed entry with `replaceState`. Repeated managed destinations coalesce
around the first target. Pre-mount/foreign entries and full-document navigation
remain outside the custom asynchronous guarantee.

`scripts/build-ncsc-questionnaire-preview.js` creates an explicitly synthetic
preview outside runtime packaging. It bundles the candidate source and metadata,
uses an injected in-memory transport and retains a no-network CSP. Native width
controls resize its existing questionnaire iframe without recreating the mount.
A simulated response or generated file is not PostgreSQL persistence evidence.

The currently attempted local preview URL was explicitly rejected by Cloud
browser URL security policy. No retry, rehosting, alternate transport, injection
or alternative browser surface is authorised as a workaround. Generating a
fixture does not prove that it can be opened by the browser. AC-03 remains
unperformed until an actually permitted, materially safer surface supplies real
browser, narrow-viewport, native-keyboard and rendered-semantic observations.
A 320-pixel iframe is a browser viewport, not a physical mobile-device test.
Screen-reader observations are useful when available but are not an additional
uncited mandatory gate. Structural DOM/history tests, CSS and builds alone do
not establish AC-03.

Source review and exact-head technical gates may support a dormant source merge
while NCSC-005 remains implemented awaiting browser verification. The living
plan must retain open acceptance items and NCSC-006 remains dependent on their
completion. Runtime and first-customer gates are not waived by a source merge.

## Verification record

The first local repair checkpoint passed 223 tests across five complete focused
suites: submission mapping (44), questionnaire (90), shell (72), dashboard service
(14) and packaging (3), with zero failures/skips. A targeted run passed 23 cases:
14 additional repository cases and nine overlapping UI/uncertainty cases, giving
237 distinct passing local tests. These counts do not claim a full application
run. Independent source/readback and focused boundary checks passed. Final
negative controls show that removing the mount guard or changing a retry key
causes the intended tests to fail.

The linked NCSC-009 repair is implemented: a fresh candidate exceeding the
canonical budget becomes a definitive 413. PostgreSQL also measures its actual
JSONB text size before quota selection, audit-event construction or writes,
covering separator bytes omitted by canonical JSON. Stored malformed/oversized
records retain their 503 classification. The existing 256 KiB storage cap,
64 KiB command cap, supported Unicode, schema and authority checks are unchanged.

The UI preserves unsent text and explains a known 413: shorten the unsaved scope
before creation, or shorten rationales and save the corrected draft before
trying again. At saved revision 127 it explains that a new assessment with
shorter rationales is needed, retaining the current text without automatic
cloning. A definitive rejection clears its pending operation. Other mutation
503/transport-unknown outcomes still retain their exact operation for retry.

The living plan binds the exact source, tests and regenerated offline preview.
The final questionnaire frame SHA-256 is
`d6f6dcfbb396125542fe0812e3b9d16fa7d1ef7e38c43b39097855df43e01bec`;
its wrapper is
`6a1be6417cd2f5c21ef3dcb80f42dbdb8bffaa5626b8ab193ed7ab8c5ed62f4e`.
Both scripts compile and their CSP hashes match. The artifacts were constructed
only; no browser was opened or served.

The first published candidate, PR 201 head
`1b0b8b54621ae728d7e3c14bcc794c889771d0c1`, ran hosted CI `34144615897`:
140 of 141 actual SQL assertions passed, including all six NCSC-009 size cases.
The UI persistence journey failed its required confirmed-and-current-checked
assertion because the renderer compared profile JSON key order. A valid JSONB
receipt replay reached the client but was refused before the required fresh read.
Two focused reproductions failed the original renderer and pass the semantic
six-field repair. The integration assertion and timeout are unchanged.

After that correction, five complete focused suites passed 228 tests on
renderer `9b737107`. Final review added one enumerable-field check and one
negative test: all six affected cases passed on final renderer `e3cc00ef`, with
90 cases unselected. There was no new full 229-case run. Together with the 14
unchanged repository cases, 243 distinct local cases have passing evidence
across these checkpoints. Final source review and the generation/retry-key
negative controls pass and bind the final renderer and test file.

The local test double's JSONB size approximation is not an actual-engine result.
Root owns the repaired candidate's complete hosted application/SQL gates and
publication. Browser AC-03 remains Not Run under the recorded platform block;
no live installation or runtime readiness is claimed.
