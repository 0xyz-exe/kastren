import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

import { buildApp } from './app.js';

const unconnected = { session: { findFirst: async () => null }, user: { create: async ({data}:{data:{email:string;name:string}}) => ({id:'test-user',email:data.email,name:data.name}) } } as unknown as PrismaClient;
const unitApp = await buildApp({ prisma: unconnected, sessionSecret: 'test-only-secret-at-least-32-characters', webOrigin: 'http://localhost:5173' });
const pool = new Pool({connectionString:process.env.DATABASE_URL});
const prisma = new PrismaClient({adapter:new PrismaPg(pool)});
let ready = false;
try { const client=await pool.connect(); await client.query('SELECT 1'); client.release(); ready = true; } catch { /* Database tests skip when PostgreSQL is unavailable. */ }

afterAll(async () => { await unitApp.close(); if (ready) await prisma.$disconnect(); await pool.end(); });

describe('Fastify API security boundary', () => {
  it('serves health and OpenAPI docs without a database request', async () => {
    expect((await unitApp.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    const docs = await unitApp.inject({ method: 'GET', url: '/documentation/json' });
    expect(docs.statusCode).toBe(200);
    expect(docs.json().paths).toHaveProperty('/transactions');
  });
  it('requires a session before exposing user data', async () => {
    expect((await unitApp.inject({ method: 'GET', url: '/accounts' })).statusCode).toBe(401);
    expect((await unitApp.inject({ method: 'GET', url: '/transactions' })).statusCode).toBe(401);
  });
  it('blocks unauthenticated state changes without CSRF and Origin', async () => {
    const response = await unitApp.inject({method:'POST',url:'/auth/register',headers:{origin:'http://localhost:5173'},payload:{email:'new@example.test',password:'a-long-test-password',name:'Test'}});
        expect(response.statusCode).toBe(403);
        const issued=await unitApp.inject({method:'GET',url:'/auth/csrf'});
        const cookie=String(issued.headers['set-cookie']).split(';')[0];
        const allowed=await unitApp.inject({method:'POST',url:'/auth/register',headers:{origin:'http://localhost:5173',cookie,'x-csrf-token':issued.json().csrfToken},payload:{email:'new@example.test',password:'a-long-test-password',name:'Test'}});
    expect(allowed.statusCode).toBe(201);
  });
  it('issues a CSRF token cookie', async () => {
    const response=await unitApp.inject({method:'GET',url:'/auth/csrf'});
    expect(response.statusCode).toBe(200);
    expect(response.json().csrfToken).toBeTruthy();
    expect(response.headers['set-cookie']).toContain('kastren_csrf=');
  });
  it('restricts credentialed CORS to the configured origin or allowed mobile origin in dev', async () => {
    const denied = await unitApp.inject({method:'OPTIONS',url:'/accounts',headers:{origin:'https://attacker.invalid','access-control-request-method':'GET'}});
    expect(denied.headers['access-control-allow-origin']).not.toBe('https://attacker.invalid');
    const allowedMobile = await unitApp.inject({method:'OPTIONS',url:'/accounts',headers:{origin:'http://localhost','access-control-request-method':'GET'}});
    expect(allowedMobile.headers['access-control-allow-origin']).toBe('http://localhost');
  });
  it('rejects insecure session secrets and insecure production cookies', async () => {
    await expect(buildApp({prisma:unconnected,sessionSecret:'short',webOrigin:'http://localhost:5173'})).rejects.toThrow('at least 32 characters');
    await expect(buildApp({prisma:unconnected,sessionSecret:'test-only-secret-at-least-32-characters',webOrigin:'https://kastren.example',production:true})).rejects.toThrow('Secure cookies');
  });
});

describe.skipIf(!ready)('PostgreSQL integration', () => {
  it('persists an isolated authenticated expense and computes its account balance', async () => {
    const email=`integration-${crypto.randomUUID()}@example.test`;
    const app=await buildApp({prisma,sessionSecret:'integration-only-secret-long-enough-32',webOrigin:'http://localhost:5173'});
    let userId:string|undefined;
    try {
      const origin='http://localhost:5173';
      const csrfResponse=await app.inject({method:'GET',url:'/auth/csrf'});
      const csrf=csrfResponse.json().csrfToken as string;
      const csrfCookie=String(csrfResponse.headers['set-cookie']).split(';')[0];
      const registered=await app.inject({method:'POST',url:'/auth/register',headers:{origin,cookie:csrfCookie,'x-csrf-token':csrf},payload:{email,password:'integration-password-long',name:'Integration'}});
      expect(registered.statusCode).toBe(201);
      userId=registered.json().id as string;
      const login=await app.inject({method:'POST',url:'/auth/login',headers:{origin,cookie:csrfCookie,'x-csrf-token':csrf},payload:{email,password:'integration-password-long'}});
      expect(login.statusCode).toBe(200);
      const sessionCookie=String(login.headers['set-cookie']).split(';')[0];
      const jar=`${csrfCookie}; ${sessionCookie}`;
      const token=csrf;
      const create=async(path:string,payload:object)=>app.inject({method:'POST',url:path,headers:{origin,cookie:jar,'x-csrf-token':token},payload});
      const accountResponse=await create('/accounts',{name:'Test account',type:'bank',currency:'IDR',openingMinor:500000});
      expect(accountResponse.statusCode).toBe(201);
      const categoryResponse=await create('/categories',{name:'Test expense',type:'expense'});
      expect(categoryResponse.statusCode).toBe(201);
      const transactionResponse=await create('/transactions',{type:'expense',accountId:accountResponse.json().id,categoryId:categoryResponse.json().id,amountMinor:12500,currency:'IDR',description:'Integration expense',occurredAt:new Date().toISOString()});
      expect(transactionResponse.statusCode).toBe(201);
      const summary=await app.inject({method:'GET',url:'/dashboard/summary',headers:{cookie:jar}});
      expect(summary.statusCode).toBe(200);
      expect(summary.json().balances).toContainEqual({accountId:accountResponse.json().id,currency:'IDR',balanceMinor:'487500'});

      // Test CSV Export
      const csvRes = await app.inject({method:'GET',url:'/transactions/export.csv',headers:{cookie:jar}});
      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.headers['content-type']).toContain('text/csv');
      expect(csvRes.body).toContain('Integration expense');

      // Test Transaction Delete & recalculation
      const txId = transactionResponse.json().id as string;
      const deleteRes = await app.inject({method:'DELETE',url:`/transactions/${txId}`,headers:{origin,cookie:jar,'x-csrf-token':token}});
      expect(deleteRes.statusCode).toBe(204);
      const afterSummary = await app.inject({method:'GET',url:'/dashboard/summary',headers:{cookie:jar}});
      expect(afterSummary.json().balances).toContainEqual({accountId:accountResponse.json().id,currency:'IDR',balanceMinor:'500000'});
    } finally {
      if(userId) await prisma.user.deleteMany({where:{id:userId}});
      await app.close();
    }
  });

  it('enforces cross-user isolation on data access', async () => {
    const emailA=`user-a-${crypto.randomUUID()}@example.test`;
    const emailB=`user-b-${crypto.randomUUID()}@example.test`;
    const app=await buildApp({prisma,sessionSecret:'integration-only-secret-long-enough-32',webOrigin:'http://localhost:5173'});
    let userAId:string|undefined;
    let userBId:string|undefined;
    try {
      const origin='http://localhost:5173';
      const setupUser = async (email: string) => {
        const csrfRes = await app.inject({method:'GET',url:'/auth/csrf'});
        const csrf = csrfRes.json().csrfToken as string;
        const csrfCookie = String(csrfRes.headers['set-cookie']).split(';')[0];
        const reg = await app.inject({method:'POST',url:'/auth/register',headers:{origin,cookie:csrfCookie,'x-csrf-token':csrf},payload:{email,password:'valid-password-long',name:'User'}});
        const login = await app.inject({method:'POST',url:'/auth/login',headers:{origin,cookie:csrfCookie,'x-csrf-token':csrf},payload:{email,password:'valid-password-long'}});
        const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
        return { id: reg.json().id as string, jar: `${csrfCookie}; ${sessionCookie}`, csrf };
      };

      const userA = await setupUser(emailA);
      userAId = userA.id;
      const userB = await setupUser(emailB);
      userBId = userB.id;

      // User A creates an account
      const accRes = await app.inject({method:'POST',url:'/accounts',headers:{origin,cookie:userA.jar,'x-csrf-token':userA.csrf},payload:{name:'Private Account',type:'bank',currency:'IDR',openingMinor:100000}});
      const accountId = accRes.json().id as string;

      // User B tries to view or update User A's account
      const bUpdate = await app.inject({method:'PUT',url:`/accounts/${accountId}`,headers:{origin,cookie:userB.jar,'x-csrf-token':userB.csrf},payload:{name:'Hacked'}});
      expect(bUpdate.statusCode).toBe(404);

      // User B's account list should be empty
      const bList = await app.inject({method:'GET',url:'/accounts',headers:{cookie:userB.jar}});
      expect(bList.statusCode).toBe(200);
      expect(bList.json()).toEqual([]);
    } finally {
      if(userAId) await prisma.user.deleteMany({where:{id:userAId}});
      if(userBId) await prisma.user.deleteMany({where:{id:userBId}});
      await app.close();
    }
  });

  it('completes the full password reset lifecycle and revokes existing sessions', async () => {
    const email=`reset-${crypto.randomUUID()}@example.test`;
    let capturedToken: string | undefined;
    const sendResetEmail = async (_to: string, token: string) => {
      capturedToken = token;
    };
    const app = await buildApp({
      prisma,
      sessionSecret: 'integration-only-secret-long-enough-32',
      webOrigin: 'http://localhost:5173',
      sendResetEmail
    });
    let userId: string | undefined;
    try {
      const origin = 'http://localhost:5173';
      const csrfRes = await app.inject({ method: 'GET', url: '/auth/csrf' });
      const csrf = csrfRes.json().csrfToken as string;
      const csrfCookie = String(csrfRes.headers['set-cookie']).split(';')[0];
      const jar = csrfCookie;

      // 1. Register and sign in user
      const reg = await app.inject({
        method: 'POST',
        url: '/auth/register',
        headers: { origin, cookie: jar, 'x-csrf-token': csrf },
        payload: { email, password: 'initial-password-123', name: 'Reset User' }
      });
      expect(reg.statusCode).toBe(201);
      userId = reg.json().id as string;

      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin, cookie: jar, 'x-csrf-token': csrf },
        payload: { email, password: 'initial-password-123' }
      });
      expect(login.statusCode).toBe(200);
      const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
      const authJar = `${csrfCookie}; ${sessionCookie}`;

      // 2. Request password reset
      const reqReset = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/request',
        headers: { origin, cookie: jar, 'x-csrf-token': csrf },
        payload: { email }
      });
      expect(reqReset.statusCode).toBe(202);
      expect(capturedToken).toBeTruthy();

      // 3. Complete password reset with captured token
      const completeReset = await app.inject({
        method: 'POST',
        url: '/auth/password-reset/complete',
        headers: { origin, cookie: jar, 'x-csrf-token': csrf },
        payload: { token: capturedToken, newPassword: 'new-updated-password-456' }
      });
      expect(completeReset.statusCode).toBe(200);

      // 4. Verify old session is now revoked (fails with 401)
      const meWithOldSession = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { cookie: authJar }
      });
      expect(meWithOldSession.statusCode).toBe(401);

      // 5. Verify user can login with new password
      const newLogin = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { origin, cookie: jar, 'x-csrf-token': csrf },
        payload: { email, password: 'new-updated-password-456' }
      });
      expect(newLogin.statusCode).toBe(200);
    } finally {
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await app.close();
    }
  });

  it('enforces transaction edge cases: non-zero, currency matching, and transfer editing', async () => {
    const email = `edge-${crypto.randomUUID()}@example.test`;
    const app = await buildApp({ prisma, sessionSecret: 'integration-only-secret-long-enough-32', webOrigin: 'http://localhost:5173' });
    let userId: string | undefined;
    try {
      const origin = 'http://localhost:5173';
      const csrfRes = await app.inject({ method: 'GET', url: '/auth/csrf' });
      const csrf = csrfRes.json().csrfToken as string;
      const csrfCookie = String(csrfRes.headers['set-cookie']).split(';')[0];
      const reg = await app.inject({ method: 'POST', url: '/auth/register', headers: { origin, cookie: csrfCookie, 'x-csrf-token': csrf }, payload: { email, password: 'valid-password-long', name: 'Edge Tester' } });
      userId = reg.json().id as string;
      const login = await app.inject({ method: 'POST', url: '/auth/login', headers: { origin, cookie: csrfCookie, 'x-csrf-token': csrf }, payload: { email, password: 'valid-password-long' } });
      const jar = `${csrfCookie}; ${String(login.headers['set-cookie']).split(';')[0]}`;
      const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { origin, cookie: jar, 'x-csrf-token': csrf }, payload });
      const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, headers: { origin, cookie: jar, 'x-csrf-token': csrf }, payload });

      const accIdr = (await post('/accounts', { name: 'IDR Bank', type: 'bank', currency: 'IDR', openingMinor: 100000 })).json().id as string;
      const accUsd = (await post('/accounts', { name: 'USD Bank', type: 'bank', currency: 'USD', openingMinor: 1000 })).json().id as string;
      const catExpense = (await post('/categories', { name: 'Food', type: 'expense' })).json().id as string;

      // 1. Zero and negative amount validation rejection
      const zeroTx = await post('/transactions', { type: 'expense', accountId: accIdr, categoryId: catExpense, amountMinor: 0, currency: 'IDR', description: 'Zero amount', occurredAt: new Date().toISOString() });
      expect(zeroTx.statusCode).toBe(400);

      const negTx = await post('/transactions', { type: 'expense', accountId: accIdr, categoryId: catExpense, amountMinor: -500, currency: 'IDR', description: 'Negative amount', occurredAt: new Date().toISOString() });
      expect(negTx.statusCode).toBe(400);

      // 2. Multi-currency transfer rejection
      const crossCurTransfer = await post('/transactions', { type: 'transfer', accountId: accIdr, toAccountId: accUsd, amountMinor: 5000, currency: 'IDR', description: 'Cross-currency transfer', occurredAt: new Date().toISOString() });
      expect(crossCurTransfer.statusCode).toBe(400);

      // 3. Create second IDR account and valid transfer
      const accIdr2 = (await post('/accounts', { name: 'IDR Wallet', type: 'ewallet', currency: 'IDR', openingMinor: 50000 })).json().id as string;
      const validTransfer = await post('/transactions', { type: 'transfer', accountId: accIdr, toAccountId: accIdr2, amountMinor: 20000, currency: 'IDR', description: 'Valid transfer', occurredAt: new Date().toISOString() });
      expect(validTransfer.statusCode).toBe(201);
      const txId = validTransfer.json().id as string;
      expect(validTransfer.json().toAccountId).toBe(accIdr2);

      // 4. Update transaction from transfer to expense (verifying toAccountId is cleared to null)
      const updateToExpense = await put(`/transactions/${txId}`, { type: 'expense', accountId: accIdr, categoryId: catExpense, amountMinor: 15000, currency: 'IDR', description: 'Changed to expense', occurredAt: new Date().toISOString() });
      expect(updateToExpense.statusCode).toBe(200);
      expect(updateToExpense.json().type).toBe('expense');
      expect(updateToExpense.json().toAccountId).toBeNull();
      expect(updateToExpense.json().categoryId).toBe(catExpense);
    } finally {
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await app.close();
    }
  });
});
