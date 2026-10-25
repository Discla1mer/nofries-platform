# Questionnaire assistance — workstream 2

Status: isolated source implementation, not enabled in the deployed dashboard.

Every question includes a help panel with accepted framework guidance. A trusted
optional `mount(..., { assistance: { suggest } })` adapter can explain client
notes and return a suggested answer, exact supporting excerpts and follow-up
questions. Without the adapter, the panel explicitly says AI is unavailable and
manual answering remains usable. There is no public AI endpoint in this slice.

With the trusted adapter supplied, “Explain this question” works before the
client has entered information. It sends empty notes (even when notes have been
typed) with explicit `mode: 'explain'`. The adapter must carry that mode into
the pure request even when it attaches already-authorised document excerpts.
The prompt and validator prohibit any answer recommendation, rationale or
citation in explanation mode regardless of the attached context.
“Suggest an answer” remains the separate, explicit action that sends the notes.
Notes are capped at 4,000 characters per accepted question and retained only in
memory while the same assessment is open, including question navigation and
answer edits. “Clear these notes” erases the current question's notes and cancels
its request. Leaving, submission, access denial or destroying the mount clears
the notes. Refresh does not restore them; no local/session storage or new answer
record field is used. This is not durable client input or AI history.

The suggestion has no authority to change an answer. The client selects “Use
this answer in my draft”, reviews the draft and saves through the existing
assessment command. This records an ordinary assessment answer, **not an AI
provenance record**. No inferred evidence confidence, approval, compliance claim
or score is added. N/A suggestions remain claims requiring a rationale.

## Pure drafting contract

`createQuestionAssistanceRequest({ questionId, mode, notes, sources })` selects the
accepted question and options server-side. It accepts at most 4,000 characters
of notes and four already-authorised extracted source excerpts of 8,000
characters each, within a 48 KiB encoded payload. A source has stable `id`,
`version` and `text`; `notes` is reserved. This function does not authorise a
source, scan a document, call a model or save data.
`mode` is required and must be `explain` or `suggest`; it is included in the
hashed model input under prompt version `ncsc-question-assistance-v3`. The
uninstalled trusted adapter receives the same mode from the corresponding UI
button. Missing or unknown modes fail closed rather than inferring intent from
whether the notes happen to be empty.

`validateQuestionAssistanceResponse(request, rawJson)` rejects invalid options,
extra output fields, missing citations, unknown source IDs and invented quotes.
It returns source version/digests, prompt version, input/output digests and the
explicit `suggested_not_confirmed` state. Matching text proves where the text
came from, not whether the source is true or proves implementation. Provider
quality and adversarial model evaluation remain required.
The validated proposal, citation objects and both nested arrays are immutable;
later consumers cannot change grounded content while retaining its digests.

## Required installed agent journey

The subsequent integration must use the existing authenticated dashboard
context, never the public prospect assistant or a browser-supplied tenant ID.
Each request needs current membership, assessment permission and feature flags;
reads and confirmations must repeat those checks. Bind proposals to assessment,
question, profile version, revision and actor. Reserve worst-case inference cost
atomically before model use; respect tenant/global kill switches and the current
NZ$15 per active tenant/month cap. Do not retry paid inference automatically.

For uploads, expose only reviewed types and limits through the governed evidence
pipeline: quarantine, type/malware checks, bounded extraction and same-tenant
version authorisation. Show extraction failures and quoted page/section sources.
No arbitrary URL retrieval, macros, executable attachments, cross-tenant search
or credentials. Client consent/data eligibility precedes provider transmission.
PDF/DOCX/OCR, actual uploads and evidence release are **not implemented here**.

Before installing the adapter, implement durable proposal and decision records.
Confirmation must atomically save the answer and its audit/provenance reference
with a stable idempotency key and expected revision. An answer edited after an
AI suggestion must remain distinguishable from the original suggestion. Record
actor/time/model/prompt/source versions, accept/edit/reject and resulting answer
revision without placing document bytes or raw prompts in general logs. Timeout
after a possible write requires reconciliation, not blind replay.

## Acceptance still required

Source tests cover inert HTML, current-question binding, late replies, malformed
output, explicit confirmation and ordinary save. They do not prove the model,
atomic AI audit, evidence ingestion or actual desktop/mobile accessibility.
The optional panel is deliberately not wired into dashboard-loader or production
startup until the protected runtime/evidence/AI gates are satisfied. The UI's
client checks are defence in depth, never the server authorisation boundary.

## Integration handoff and completion evidence

The release owner retains runtime-composition, dashboard-persistence and
tenant-security. The assessment source owner can resume these integration steps
after an explicit scope handoff in the shared tracker:

| Step | Required implementation | Completion proof |
| --- | --- | --- |
| Authorised inference | Private assessment route, current membership and revision, atomic budget reservation, provider timeout and kill switches | Two-tenant denials; concurrent budget exhaustion; disabled and timed-out provider preserves manual answers |
| Documents | Governed evidence upload, quarantine and bounded extraction; authorised immutable source versions | Rejected unsafe/oversized files; stale or other-tenant source denied; page/section quotes visible to client |
| Answer history | Immutable proposal plus accept/edit/reject decision; answer and audit in one transaction | Rollback leaves neither write; duplicate confirmation yields one decision; stale revision cannot replace an answer |
| Browser composition | Install private adapter and evidence picker; use server proposal ID for confirmation | Actual desktop and 320/390px mobile journey; keyboard error links target answers; interruption/resume and saved history verified |

Do not install the current ordinary-save preview adapter as the final agent:
its confirmation action must first be connected to the atomic decision command.
The existing input/output validator can be reused inside that private route;
it grants no evidence access and substitutes for none of the checks above.
