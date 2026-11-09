# Managed IT onboarding discovery

This slice expands the private staff service review. It records customer claims
and supporting references. It does not install tools, accept responsibility for a
service, promise supplier compatibility, calculate a new price or approve changes.

The expansion defaults off. Set `NOFRIES_MANAGED_IT_DISCOVERY_ENABLED=true`
explicitly to expose the new blueprint and accept its answers. Unset, false and
other values keep the original 22 questions, version and timings; retained
expansion answers are excluded from proposal-review evidence while disabled.
Saving while disabled preserves existing expansion answers and ignores changes
or additions to them, so switching the flag off does not erase saved work.

## Gap assessment

On public main `ec6f558`, the review has 22 questions in six sections. It covers
business goals, broad user/device/location counts, support, endpoint protection,
computer-file backup and a basic provider handover. It combines computers and
supported servers in one count. The standard service guide explicitly excludes
automatic protection of servers, network storage and cloud applications from
computer-file backup.

| Area | Existing gap | Added discovery | Still required before accepting support |
| --- | --- | --- | --- |
| Voice | No platform, number, routing or ownership detail | Platform/supplier, users/numbers/routes, analog dependencies, emergency-calling questions, support/recording ownership and outage fallback | Supplier-specific validation, agreed responsibility and owner-approved calling/failover tests; any number transfer is separate work |
| Servers | Only a combined device count and important-app text | Hosts, VMs and storage separately; roles/OS/support/dependencies; patch/restart owners; backup scope, retention, acceptable loss/downtime and restore evidence | Reconciled inventory, supportability review and application-level restore/rollback acceptance; do not price every server as a spare staff computer |
| Web | No registrar/DNS/hosting chain | Domain/website inventory, registrar/DNS/hosting/certificate ownership, renewals, supplier boundaries, restore and transaction tests | Confirm account authority and technical scope, then test the actual business journeys; uptime alone does not prove checkout or email delivery |
| Authority and rollout | Provider count and handover yes/no only | Decision and escalation roles, access/disruption/spending approval, OS and existing-agent facts, correct site, restrictions, pilot and rollback | Secure access handover, provider requirements, support entitlement, approved change window and checked pilot |
| Cost and contracts | General budget/commercial-position questions | Per-supplier recurring charge/currency, billing owner, renewals/expiry, notice, usage/storage and transition fees | Confirm quoted amounts and service schedule; no spending authority or additional service inclusion is inferred |

The new blueprint has 37 questions. Nine technical prompts appear only after
the relevant voice/server/web gate is answered **Yes** or **Not yet confirmed**.
Unanswered gates remain gaps. **No** hides the details without deleting earlier
answers, so changing back preserves the draft and resets dependent facts to
**Needs confirmation**. New technical and operations facts remain in gap mode
until the operator explicitly marks them **Confirmed with owner and evidence**.
Editing them resets that status. Hidden or unconfirmed details are excluded
from proposal-review evidence. This status is an operator attestation, not an
automated verification of the evidence. The existing completion and
proposal-review controls are unchanged; completion is not technical acceptance.

The six existing sections and original question IDs/options remain. Existing
saved reviews can be reopened with their answers intact; new records identify
blueprint `2026.11.1`. The displayed 40-minute estimate is a planning allowance,
not measured completion time. Complex estates may require follow-up meetings.

For each service, use the existing notes/evidence/confidence fields to record:

- Customer and supplier owner roles, what is included, excluded or retained.
- A source reference, verification date and whether the fact is confirmed.
- An unresolved question, next action, accountable owner and due date.
- Required customer/supplier approvals before any disruptive or paid work.

Keep passwords, keys, installer secrets, transfer/recovery codes, customer
records and raw security settings out of the review. Record who controls access
and the approved secure handover process instead. The questionnaire warning is
guidance, not a new secret-detection control.

## Datto boundary and sources

Official documentation checked 7 November 2026. The questions above are
vendor-neutral MSP discovery, not a claim that Datto mandates these answers.

- [Agent requirements](https://rmm.datto.com/help/en/Content/1INTRODUCTION/Requirements/AgentRequirements.htm): verify exact OS support against the current matrix.
- [Windows installation](https://rmm.datto.com/help/en/Content/3NEWUI/Devices/AddADevice/Windows/InstallWindows.htm) and [site configuration](https://rmm.datto.com/help/en/Content/3NEWUI/Sites/CreateASite.htm): confirm installation authority and the intended customer/site. Existing tools, restrictions and pilot decisions still need review.
- [Allowlist requirements](https://rmm.datto.com/help/en/Content/1INTRODUCTION/Requirements/AllowListRequirements.htm): core outbound connectivity and feature-specific needs are separate. This review authorizes no firewall exceptions or inbound port exposure.
- [Network discovery](https://rmm.datto.com/help/en/Content/3NEWUI/Sites/NetworkDiscovery.htm): confirm scan permission and a suitable node. Datto cautions about DHCP-server scanning nodes and VoIP impact.
- [SNMP](https://rmm.datto.com/help/en/Content/3NEWUI/Devices/AddADevice/ManageMonitorSNMPDevices.htm) and [ESXi monitoring](https://rmm.datto.com/help/en/Content/3NEWUI/Devices/AddADevice/ManageMonitorESXiDevices.htm): network devices and hypervisors have distinct monitoring methods. An endpoint agent is not a universal solution.
- [Website monitoring](https://rmm.datto.com/help/en/Content/2SETUP/BestPractices/Best_Practices_Website_Monitoring.htm): content/certificate checks do not establish transaction success or website maintenance responsibility.
- [NIST MSP backup guidance](https://csrc.nist.gov/pubs/other/2020/04/24/protecting-data-from-ransomware-and-other-data-los/final): backup operation and tested recovery are distinct.

## Validation boundaries

Validation covers application/native database CI and synthetic desktop/mobile
browser checks of branching, gap mode, focus, confirmation and draft save/reopen.
It does not establish live identity-provider acceptance or supplier support.
Customer-specific service schedules and technical onboarding plans still require
the operator's review. This change has no deployment authority.
