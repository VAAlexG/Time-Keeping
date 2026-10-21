# Xero Projects implementation: first connector commit

User approval: Projects-first timekeeping and billing workflow. Direct draft invoices are not selected for implementation.

This branch begins the implementation with real server-side connector modules: contracts, AES-GCM token encryption, OAuth with PKCE and actor-bound single-use state, explicit organisation confirmation, rotating refresh tokens, bounded/allow-listed API requests, rate-limit handling, and verified client/staff catalogue mappings.

The existing Worker entrypoint, live schedules and main branch are unchanged. These modules are deliberately not wired into production yet. No Xero, Cloudflare or email credentials have been added and no real records have been uploaded.

## Companion pilot source package

The broader development implementation was delivered in this ChatGPT conversation as `Timekeeper-Projects-Implementation.zip`. It contains the complete combined overlay, a patch against main at `1a00dc348d4d3fcaae92a469714014a4bf549007`, an incremental patch against the original Friday-close package, the new entry/review/setup form, database migrations 0005/0006, protected time/approval/upload services, Friday integration, and billing-status polling.

That package is a working source overlay, not a complete repository or a production release. Its remaining modules have not yet been committed in this first connector-only PR. Apply and review the companion package in the full development workspace to continue this branch; preserve unrelated changes and do not apply both patches. On this feature branch, use the overlay after reconciling files already committed, rather than blindly applying the baseline patch.

33 focused local tests passed for the combined source using SQLite with a D1-shaped transactional adapter and synthetic Xero responses. Backend modules passed a standalone strict TypeScript check. Browser JavaScript passed syntax checking. These are NOT full Cloudflare/workerd, existing-regression, browser, live OAuth, real upload or actual email-delivery tests. Full dependency installation/build was unavailable in the current execution environment; a browser rendering attempt was blocked by environment policy. The included repository-native security tests still need the normal Vitest/workerd run.

## Required next gates

- Integrate the full combined overlay, including Friday-close prerequisites, in this feature workspace.
- Run formatting, lint, full TypeScript checking, all tests and Worker dry-run build; address failures before any merge/deploy.
- Stage with a separate D1 database and test recipient, then verify the actual authenticated UI.
- Configure the four Xero secrets securely (client ID, client secret, exact HTTPS callback, 32-byte base64 token encryption key); do not paste them into GitHub or chat.
- Authorise and explicitly select Versatile Accounting's own Xero organisation. Keep uploads paused while verifying mappings, task rates and a cutover date with Suzie.
- Verify one complete recorded/closed/reviewed/uploaded/invoiced-status pilot and duplicate prevention before production activation.

Suzie's invoice workflow stays in Xero. Projects time marked INVOICED is not proof of payment; invoice authorisation and payment reconciliation are not implemented in the pilot. Existing projects/tasks are reused; automatic project creation and changes to charge-out rates are not performed.
