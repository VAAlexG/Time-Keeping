import { audit, connection } from './oauth';
import { projectPages, xeroRequest } from './api';
import { enabled, requireAdmin, requireId, XeroProblem, type Actor, type XProject, type XTask, type XUser, type XeroEnv } from './types';
export async function tenant(env: XeroEnv): Promise<string> {
  enabled(env); const c = await connection(env.DB);
  if (!c?.connected || !c.tenant_id) throw new XeroProblem('RECONNECT', 'Connect and confirm the practice Xero organisation.', 503);
  return c.tenant_id;
}
export async function cached<T>(db: D1Database, tenantId: string, kind: string, id: string): Promise<{ data: T; fetchedAt: number }> {
  const row = await db.prepare('SELECT data_json,fetched_at FROM xero_catalog WHERE tenant_id=? AND kind=? AND id=? AND active=1').bind(tenantId, kind, id).first<{ data_json: string; fetched_at: number }>();
  if (!row) throw new XeroProblem('CATALOGUE', 'Refresh the catalogue and choose a current project, task or staff member.', 409);
  return { data: JSON.parse(row.data_json) as T, fetchedAt: row.fetched_at };
}
async function replaceCache(db: D1Database, tenantId: string, kind: string, rows: { id: string; parent: string; data: unknown }[], now: number, parent?: string) {
  const statements = rows.map(row => db.prepare(`INSERT INTO xero_catalog VALUES(?,?,?,?,?,1,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET parent_id=excluded.parent_id,data_json=excluded.data_json,active=1,fetched_at=excluded.fetched_at`).bind(tenantId, kind, row.id, row.parent, JSON.stringify(row.data), now));
  statements.push(db.prepare(`UPDATE xero_catalog SET active=0 WHERE tenant_id=? AND kind=? AND fetched_at<>?${parent ? ' AND parent_id=?' : ''}`).bind(tenantId, kind, now, ...(parent ? [parent] : [])));
  statements.push(db.prepare('UPDATE xero_connection SET revision=revision+1 WHERE id=1'));
  await db.batch(statements);
}
export async function refreshCatalogue(env: XeroEnv, actor: Actor, projectId?: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  requireAdmin(actor); const tenantId = await tenant(env);
  if (projectId) {
    requireId(projectId, 'project');
    const project = await xeroRequest<XProject>(env, `/Projects/${projectId}`, { tenantId, fetcher, now });
    if (project.projectId !== projectId) throw new XeroProblem('RESPONSE', 'Xero returned a different project.', 502);
    const tasks = await projectPages<XTask>(env, `/Projects/${projectId}/Tasks`, tenantId, fetcher, now);
    for (const task of tasks) { requireId(task.taskId); if (task.projectId !== projectId || !['TIME','FIXED','NON_CHARGEABLE'].includes(task.chargeType) || !Number.isFinite(task.rate?.value)) throw new XeroProblem('RESPONSE', 'Invalid Xero task or rate.', 502); }
    await replaceCache(env.DB, tenantId, 'task', tasks.map(t => ({ id: t.taskId, parent: projectId, data: t })), now, projectId);
    await env.DB.prepare(`UPDATE xero_catalog SET data_json=?,active=1,fetched_at=? WHERE tenant_id=? AND kind='project' AND id=?`).bind(JSON.stringify(project), now, tenantId, projectId).run();
    return { tasks: tasks.length };
  }
  const projects = await projectPages<XProject>(env, '/Projects', tenantId, fetcher, now);
  const users = await projectPages<XUser>(env, '/ProjectsUsers', tenantId, fetcher, now);
  for (const p of projects) { requireId(p.projectId); requireId(p.contactId); }
  for (const u of users) { requireId(u.userId); if (typeof u.email !== 'string') throw new XeroProblem('RESPONSE', 'A Projects user is missing an email.', 502); }
  await replaceCache(env.DB, tenantId, 'project', projects.map(p => ({ id: p.projectId, parent: p.contactId, data: p })), now);
  await replaceCache(env.DB, tenantId, 'user', users.map(u => ({ id: u.userId, parent: '', data: u })), now);
  await audit(env.DB, actor, 'catalogue_refreshed', tenantId, { projects: projects.length, users: users.length }, now).run();
  return { projects: projects.length, users: users.length };
}
export async function mapClient(env: XeroEnv, actor: Actor, clientId: string, contactId: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  requireAdmin(actor); requireId(clientId); requireId(contactId); const tenantId = await tenant(env);
  const client = await env.DB.prepare('SELECT id,name FROM clients WHERE id=? AND active=1').bind(clientId).first<{ id: string; name: string }>();
  if (!client) throw new XeroProblem('CLIENT', 'Choose an active Timekeeper client.');
  const body = await xeroRequest<{ Contacts?: { ContactID: string; Name: string; ContactStatus: string }[] }>(env, `/Contacts/${contactId}`, { tenantId, accounting: true, fetcher, now });
  const contact = body.Contacts?.find(c => c.ContactID === contactId && c.ContactStatus === 'ACTIVE');
  if (!contact) throw new XeroProblem('CONTACT', 'Choose an active Xero contact in the connected organisation.');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO xero_client_links VALUES(?,?,?) ON CONFLICT(tenant_id,client_id) DO UPDATE SET contact_id=excluded.contact_id`).bind(tenantId, clientId, contactId),
    env.DB.prepare(`INSERT INTO xero_catalog VALUES(?,'contact',?,'',?,1,?) ON CONFLICT(tenant_id,kind,id) DO UPDATE SET data_json=excluded.data_json,active=1,fetched_at=excluded.fetched_at`).bind(tenantId, contactId, JSON.stringify({ ContactID: contact.ContactID, Name: contact.Name }), now),
    env.DB.prepare('UPDATE xero_connection SET revision=revision+1 WHERE id=1'),
    audit(env.DB, actor, 'client_mapping', clientId, { contactId, contactName: contact.Name, clientName: client.name }, now),
  ]);
  return { clientName: client.name, contactName: contact.Name };
}
export async function mapUser(env: XeroEnv, actor: Actor, userId: string, xeroUserId: string, acknowledgeDifferentEmail = false, now = Date.now()) {
  requireAdmin(actor); requireId(userId); requireId(xeroUserId); const tenantId = await tenant(env);
  const user = await env.DB.prepare('SELECT id,email,display_name FROM users WHERE id=?').bind(userId).first<{ id: string; email: string; display_name: string }>();
  const remote = (await cached<XUser>(env.DB, tenantId, 'user', xeroUserId)).data;
  if (!user) throw new XeroProblem('EMPLOYEE', 'Choose an existing Timekeeper employee.');
  if (user.email.toLowerCase() !== remote.email.toLowerCase() && !acknowledgeDifferentEmail) throw new XeroProblem('EMAIL_MISMATCH', 'The emails differ. Verify both identities and acknowledge the mapping.');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO xero_user_links VALUES(?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET xero_user_id=excluded.xero_user_id`).bind(tenantId, userId, xeroUserId),
    env.DB.prepare('UPDATE xero_connection SET revision=revision+1 WHERE id=1'),
    audit(env.DB, actor, 'employee_mapping', userId, { xeroUserId, localEmail: user.email, xeroEmail: remote.email, acknowledgeDifferentEmail }, now),
  ]);
}
