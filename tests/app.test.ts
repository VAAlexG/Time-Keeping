import session from 'express-session';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { hashPassword } from '../server/auth';
import { MemoryTimeStore } from './memory-store';

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword('test-password');
});

function fixture() {
  const store = new MemoryTimeStore();
  let current = new Date('2026-08-06T00:00:00.000Z');
  const app = createApp({
    store,
    sessionStore: new session.MemoryStore(),
    passwordHash,
    sessionSecret: 'a-test-session-secret-that-is-at-least-32-characters',
    now: () => current,
  });
  return {
    store,
    app,
    setNow: (value: string) => {
      current = new Date(value);
    },
  };
}

async function login(agent: request.Agent) {
  const response = await agent.post('/api/login').send({ password: 'test-password' }).expect(200);
  return response.body.csrfToken as string;
}

describe('authentication', () => {
  it('protects application APIs and creates a recoverable authenticated session', async () => {
    const { app } = fixture();
    const agent = request.agent(app);
    await agent.get('/api/dashboard').expect(401);
    await agent.post('/api/login').send({ password: 'wrong' }).expect(401);
    const csrf = await login(agent);
    expect(csrf).toBeTruthy();
    await agent.get('/api/dashboard').expect(200);
    const recovered = await agent.get('/api/session').expect(200);
    expect(recovered.body).toMatchObject({ authenticated: true, csrfToken: csrf });
    await agent.post('/api/logout').set('x-csrf-token', csrf).expect(204);
    await agent.get('/api/dashboard').expect(401);
  });

  it('rate limits repeated incorrect password attempts', async () => {
    const { app } = fixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post('/api/login').send({ password: 'wrong' }).expect(401);
    }
    await request(app).post('/api/login').send({ password: 'wrong' }).expect(429);
  });
});

describe('time tracking API', () => {
  it('clocks in and out and prevents a second active timer', async () => {
    const { app, setNow } = fixture();
    const agent = request.agent(app);
    const csrf = await login(agent);
    const started = await agent
      .post('/api/clock-in')
      .set('x-csrf-token', csrf)
      .send({ projectName: 'Coding project', notes: 'Feature work' })
      .expect(201);
    expect(started.body.entry.endAt).toBeNull();
    await agent
      .post('/api/clock-in')
      .set('x-csrf-token', csrf)
      .send({ projectName: 'Accounting' })
      .expect(409);
    setNow('2026-08-06T01:35:00.000Z');
    const stopped = await agent.post('/api/clock-out').set('x-csrf-token', csrf).expect(200);
    expect(stopped.body.entry.endAt).toBe('2026-08-06T01:35:00.000Z');
    const dashboard = await agent.get('/api/dashboard').expect(200);
    expect(dashboard.body.active).toBeNull();
    expect(dashboard.body.today.totalMs).toBe(95 * 60_000);
  });

  it('validates manual entries on the server and supports edit and delete', async () => {
    const { app } = fixture();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .post('/api/entries')
      .set('x-csrf-token', csrf)
      .send({
        projectName: 'Accounting',
        notes: '',
        startLocal: '2026-08-06T12:00',
        endLocal: '2026-08-06T11:00',
      })
      .expect(400);
    const created = await agent
      .post('/api/entries')
      .set('x-csrf-token', csrf)
      .send({
        projectName: 'Accounting',
        notes: 'Reconciliation',
        startLocal: '2026-08-06T10:00',
        endLocal: '2026-08-06T11:00',
      })
      .expect(201);
    const id = created.body.entry.id;
    const updated = await agent
      .put(`/api/entries/${id}`)
      .set('x-csrf-token', csrf)
      .send({
        projectName: 'Client accounts',
        notes: 'Corrected',
        startLocal: '2026-08-06T10:00',
        endLocal: '2026-08-06T11:30',
      })
      .expect(200);
    expect(updated.body.entry.projectName).toBe('Client accounts');
    await agent.delete(`/api/entries/${id}`).set('x-csrf-token', csrf).expect(204);
  });

  it('completes the primary workflow through totals and Excel download', async () => {
    const { app, setNow } = fixture();
    const agent = request.agent(app);
    const csrf = await login(agent);
    await agent
      .post('/api/clock-in')
      .set('x-csrf-token', csrf)
      .send({ projectName: 'Coding project', notes: 'End-to-end verification' })
      .expect(201);
    setNow('2026-08-06T02:00:00.000Z');
    const stopped = await agent.post('/api/clock-out').set('x-csrf-token', csrf).expect(200);
    await agent
      .put(`/api/entries/${stopped.body.entry.id}`)
      .set('x-csrf-token', csrf)
      .send({
        projectName: 'Coding project',
        notes: 'Reviewed and corrected',
        startLocal: '2026-08-06T10:00',
        endLocal: '2026-08-06T12:15',
      })
      .expect(200);
    const dashboard = await agent.get('/api/dashboard').expect(200);
    expect(dashboard.body.today.totalMs).toBe(135 * 60_000);
    expect(dashboard.body.week.projectTotals).toEqual([
      { projectName: 'Coding project', totalMs: 135 * 60_000 },
    ]);
    const report = await agent
      .get('/api/reports/weekly.xlsx?weekStart=2026-08-03')
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect('Content-Type', /spreadsheetml/)
      .expect(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(report.body as ExcelJS.Buffer);
    expect(workbook.getWorksheet('Weekly time report')?.getCell('A1').value).toBe(
      'Weekly Time Report',
    );
  });
});
