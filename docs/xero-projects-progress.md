# Xero Projects implementation status

Timekeeper now contains the integrated, Projects-first reviewed-time workflow. Direct draft-invoice creation is intentionally outside scope.

## Implemented in this repository

- Friday 20:00 Brisbane locking, boundary splitting, immutable report versions and durable per-recipient report delivery.
- Server-side confidential-client Xero OAuth with actor-bound single-use state, rotating encrypted tokens and exact organisation confirmation. PKCE is intentionally not added because Xero's documented web-app flow authenticates the token exchange with the client secret.
- A complete, tenant-bound cache of Xero contacts, projects, tasks and users with explicit FYI-client, FYI-job and employee mappings.
- Entry-level Xero project/task snapshots, including support for client time without an FYI job.
- Reviewer preview and approval of an immutable payload hash before a durable upload item is created.
- Conservative upload retry, ambiguous-write quarantine, source-drift handling and read-only Xero Projects status refresh.
- Worker API routes and React screens for time entry, Xero setup/mapping, billing review and closed-report downloads.
- Forward-only D1 migrations `0010_friday_close_and_reports.sql` and `0011_xero_projects_workflow.sql`.

FYI remains the read-only source of truth for clients and jobs. Xero Projects is only the downstream destination for approved client time. Existing projects and tasks are reused; Timekeeper does not create projects, change task rates, create invoices or infer payment.

## Release boundary

Repository implementation is not evidence of a production release. A merge, Worker deployment, remote migration, Friday-close activation, report send, Xero connection, catalogue refresh against a live tenant, approval, unpause or upload must each follow its own recorded authorisation.

Before any live action, complete the [release checklist](./xero-projects-release-checklist.md) and follow the [production runbook](./xero-projects-runbook.md). Keep `XERO_ENABLED=false`, keep processing paused and use a separate staging Worker/D1 database, safe report mailbox and Xero Demo Company until the staging gates are complete.

No credentials or secret values belong in this file, Git, tickets, chat, screenshots or logs.
