import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PrismaClient, type Transaction } from '@prisma/client';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { z } from 'zod';

const emailSchema = z.string().trim().email().max(320).transform(v => v.toLowerCase());
const uuidSchema = z.string().uuid();
const passwordSchema = z.string().min(12).max(128);
const nameSchema = z.string().trim().min(1).max(100);
const moneySchema = z.number().finite().positive().max(1_000_000_000_000).refine(v => Number.isInteger(v), 'Amount must be integer minor units.');
const transactionSchema = z.object({
  type: z.enum(['income', 'expense', 'transfer']),
  accountId: uuidSchema,
  toAccountId: uuidSchema.optional(),
  categoryId: uuidSchema.nullable().optional(),
  amountMinor: moneySchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  description: z.string().trim().min(1).max(120),
  notes: z.string().max(1000).nullable().optional(),
  occurredAt: z.string().datetime(),
}).strict().superRefine((v, ctx) => {
  if (v.type === 'transfer' && (!v.toAccountId || v.toAccountId === v.accountId || v.categoryId)) ctx.addIssue({ code: 'custom', message: 'Transfer requires distinct source/destination accounts and no category.' });
  if (v.type !== 'transfer' && v.toAccountId) ctx.addIssue({ code: 'custom', message: 'Only transfers may specify a destination account.' });
  if (v.type !== 'transfer' && !v.categoryId) ctx.addIssue({ code: 'custom', message: 'Income and expenses require a category.' });
});
const listSchema = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25), start: z.string().datetime().optional(), end: z.string().datetime().optional(), type: z.enum(['income','expense','transfer']).optional(), accountId: z.string().uuid().optional(), categoryId: z.string().uuid().optional() }).strict().refine(v => !v.start || !v.end || v.start <= v.end, 'Start must not exceed end.');
const passwordUpdateSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict();
const profileUpdateSchema = z.object({ name: nameSchema }).strict();
const accountUpdateSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const categoryUpdateSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();
const budgetSchema = z.object({ categoryId: uuidSchema, currency: z.string().regex(/^[A-Z]{3}$/), limitMinor: moneySchema, month: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/) }).strict();
const goalSchema = z.object({ name: z.string().trim().min(1).max(80), targetMinor: moneySchema, currency: z.string().regex(/^[A-Z]{3}$/), targetDate: z.string().datetime().nullable().optional() }).strict();
const contributionSchema = z.object({ amountMinor: moneySchema, occurredAt: z.string().datetime() }).strict();
const debtSchema = z.object({ party: z.string().trim().min(1).max(100), kind: z.enum(['owed','receivable']), principalMinor: moneySchema, currency: z.string().regex(/^[A-Z]{3}$/), dueAt: z.string().datetime().nullable().optional() }).strict();
const paymentSchema = z.object({ amountMinor: moneySchema, occurredAt: z.string().datetime() }).strict();
const recurringSchema = z.object({ type: z.enum(['income','expense']), accountId: uuidSchema, categoryId: uuidSchema, currency: z.string().regex(/^[A-Z]{3}$/), amountMinor: moneySchema, description: z.string().trim().min(1).max(120), frequency: z.enum(['daily','weekly','monthly','yearly']), startsAt: z.string().datetime(), endsAt: z.string().datetime().nullable().optional() }).strict();
const accountSchema = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(['cash','bank','ewallet','savings','credit','other']), currency: z.string().regex(/^[A-Z]{3}$/).default('IDR'), openingMinor: z.number().int().min(0).max(1_000_000_000_000).default(0) }).strict();
const categorySchema = z.object({ name: z.string().trim().min(1).max(60), type: z.enum(['income','expense']) }).strict();
const registerSchema = z.object({ email: emailSchema, password: passwordSchema, name: nameSchema }).strict();
const loginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict();
const passwordResetCompleteSchema = z.object({ token: z.string().min(16).max(128), newPassword: passwordSchema }).strict();
type Deps = { prisma: PrismaClient; sessionSecret: string; webOrigin: string; secureCookies?: boolean; production?: boolean; sendResetEmail?: (email: string, token: string) => Promise<void> };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw Object.assign(new Error('Invalid request.'), { statusCode: 400, issues: result.error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) });
  return result.data;
}
const transactionView = (row: Transaction) => ({ id: row.id, type: row.type, accountId: row.accountId, toAccountId: row.toAccountId, categoryId: row.categoryId, amountMinor: row.amountMinor.toString(), currency: row.currency, description: row.description, notes: row.notes, occurredAt: row.occurredAt.toISOString(), createdAt: row.createdAt.toISOString() });

export async function buildApp(deps: Deps) {
  if (deps.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  if (deps.production && !deps.secureCookies) throw new Error('Secure cookies must be enabled in production.');
  const allowedOrigin = new URL(deps.webOrigin);
  if (!allowedOrigin.hostname || !['http:', 'https:'].includes(allowedOrigin.protocol)) throw new Error('WEB_ORIGIN must be an http(s) origin.');
  const mobileOrigins = new Set(['http://localhost', 'https://localhost', 'capacitor://localhost']);
  const isOriginAllowed = (origin?: string) => origin === allowedOrigin.origin || (!deps.production && origin ? (mobileOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin)) : false);
  const app = Fastify({ logger: { level: deps.production ? 'info' : 'warn', redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.body.password', 'req.body.passwordHash'], censor: '[REDACTED]' } }, trustProxy: false, bodyLimit: 64 * 1024 });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'none'"] } } });
  await app.register(cors, { origin: (origin, callback) => callback(null, isOriginAllowed(origin)), credentials: true, methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['content-type','x-csrf-token','authorization'] });
  await app.register(cookie, { secret: deps.sessionSecret });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { info: { title: 'Kastren API', version: '0.1.0' }, servers: [{ url: deps.webOrigin }] } });
  await app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'list', deepLinking: false } });
  app.get('/documentation/json', async () => app.swagger());
  app.get('/documentation/yaml', async () => app.swagger({ yaml: true }));
  const sessionCookie = 'kastren_session';
  const csrfCookie = 'kastren_csrf';
  const cookieOptions = { path: '/', httpOnly: true, secure: deps.secureCookies ?? false, sameSite: (deps.production ? 'strict' : 'lax') as 'strict' | 'lax' };
  const setCsrf = (reply: FastifyReply) => { const value = randomBytes(32).toString('base64url'); reply.setCookie(csrfCookie, value, { ...cookieOptions, httpOnly: false, maxAge: 3600 }); return value; };
  const clearAuthCookies = (reply: FastifyReply) => { reply.clearCookie(sessionCookie, { path: '/', sameSite: (deps.production ? 'strict' : 'lax') as 'strict' | 'lax', secure: deps.secureCookies ?? false }); reply.clearCookie(csrfCookie, { path: '/', sameSite: (deps.production ? 'strict' : 'lax') as 'strict' | 'lax', secure: deps.secureCookies ?? false }); };
  const auth = async (req: FastifyRequest) => {
    const authHeader = req.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;
    const token = req.cookies[sessionCookie] ?? bearer;
    if (!token) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 });
    const row = await deps.prisma.session.findFirst({ where: { tokenHash: sha(token), expiresAt: { gt: new Date() } }, select: { id: true, userId: true, user: { select: { id: true, email: true, name: true } } } });
    if (!row) { throw Object.assign(new Error('Authentication required.'), { statusCode: 401 }); }
    (req as FastifyRequest & { session: typeof row }).session = row;
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const csrf = req.headers['x-csrf-token'];
      const cookie = req.cookies[csrfCookie];
      const origin = req.headers.origin;
      if (!origin || !isOriginAllowed(origin)) return reply.code(403).send({ error: 'Origin not allowed.' });
      const isMobileDev = !deps.production && (mobileOrigins.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin));
      if (!isMobileDev) {
        if (typeof csrf !== 'string' || !cookie || Buffer.byteLength(csrf) !== Buffer.byteLength(cookie) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(cookie))) return reply.code(403).send({ error: 'CSRF validation failed.' });
      } else {
        if (cookie) {
          if (typeof csrf !== 'string' || Buffer.byteLength(csrf) !== Buffer.byteLength(cookie) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(cookie))) return reply.code(403).send({ error: 'CSRF validation failed.' });
        } else if (typeof csrf !== 'string' || !csrf) {
          return reply.code(403).send({ error: 'CSRF validation failed.' });
        }
      }
    }
    if (req.url === '/docs' || req.url.startsWith('/docs/')) {
      if (!['127.0.0.1','::1'].includes(req.ip) && !req.ip.startsWith('127.') && !req.ip.startsWith('::ffff:127.')) return reply.code(404).send({ error: 'Not found.' });
    }
  });
  app.setErrorHandler((error: Error & { statusCode?: number; issues?: unknown }, _req, reply) => {
    const status = Number(error.statusCode ?? 500);
    if (status >= 500) app.log.error({ err: error }, 'Request failed');
    return reply.code(status >= 400 && status < 600 ? status : 500).send({ error: status >= 500 ? 'Internal server error.' : error.message, ...(status === 400 && error.issues ? { issues: error.issues } : {}) });
  });
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/auth/csrf', async (_req, reply) => ({ csrfToken: setCsrf(reply) }));
  app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(registerSchema, req.body);
    const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    let user;
    try { user = await deps.prisma.user.create({ data: { email: body.email, name: body.name, passwordHash } }); }
    catch (error) { if ((error as { code?: string }).code === 'P2002') throw Object.assign(new Error('Email already registered.'), { statusCode: 409 }); throw error; }
    return reply.code(201).send({ id: user.id, email: user.email, name: user.name });
  });
  app.post('/auth/password-reset/request', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const { email } = parse(z.object({ email: emailSchema }).strict(), req.body);
    const user = await deps.prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (user) {
      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = sha(rawToken);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await deps.prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
      await deps.prisma.passwordResetToken.create({
        data: { tokenHash, userId: user.id, expiresAt }
      });
      if (deps.sendResetEmail) {
        await deps.sendResetEmail(user.email, rawToken);
      } else if (!deps.production) {
        req.log.info({ email: user.email, resetToken: rawToken }, 'Password reset token generated');
      }
    }
    return reply.code(202).send({ message: 'If the account exists, password reset instructions will be sent.' });
  });
  app.post('/auth/password-reset/complete', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(passwordResetCompleteSchema, req.body);
    const tokenHash = sha(body.token);
    const resetRecord = await deps.prisma.passwordResetToken.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } }
    });
    if (!resetRecord) {
      throw Object.assign(new Error('Invalid or expired password reset token.'), { statusCode: 400 });
    }
    const passwordHash = await argon2.hash(body.newPassword, {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1
    });
    await deps.prisma.$transaction([
      deps.prisma.user.update({
        where: { id: resetRecord.userId },
        data: { passwordHash }
      }),
      deps.prisma.passwordResetToken.deleteMany({
        where: { userId: resetRecord.userId }
      }),
      deps.prisma.session.deleteMany({
        where: { userId: resetRecord.userId }
      })
    ]);
    clearAuthCookies(reply);
    return reply.code(200).send({ message: 'Password reset successful. Please sign in with your new password.' });
  });
  app.post('/auth/password',{preHandler:auth},async(req,reply)=>{const session=(req as FastifyRequest&{session:{id:string;userId:string}}).session,body=parse(passwordUpdateSchema,req.body),user=await deps.prisma.user.findUnique({where:{id:session.userId}});if(!user||!await argon2.verify(user.passwordHash,body.currentPassword).catch(()=>false))throw Object.assign(new Error('Invalid password.'),{statusCode:401});const passwordHash=await argon2.hash(body.newPassword,{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});await deps.prisma.$transaction([deps.prisma.user.update({where:{id:session.userId},data:{passwordHash}}),deps.prisma.session.deleteMany({where:{userId:session.userId,id:{not:session.id}}})]);return reply.code(204).send();});
  app.put('/auth/profile',{preHandler:auth},async(req,reply)=>{const s=(req as FastifyRequest&{session:{userId:string}}).session,b=parse(profileUpdateSchema,req.body);await deps.prisma.user.update({where:{id:s.userId},data:{name:b.name}});return reply.code(204).send();});
  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const user = await deps.prisma.user.findUnique({ where: { email: body.email } });
    const hash = user?.passwordHash ?? '$argon2id$v=19$m=19456,t=2,p=1$7cG23Elzkv1s1E0t0F0rIQ$khPLqx0wURc2xSncV0Nlq5t9Ije2Jf05LPPTq+TET/8';
    const matched = await argon2.verify(hash, body.password).catch(() => false);
    if (!user || !matched) throw Object.assign(new Error('Invalid email or password.'), { statusCode: 401 });
    const token = randomBytes(32).toString('base64url');
    await deps.prisma.session.create({ data: { tokenHash: sha(token), userId: user.id, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    reply.setCookie(sessionCookie, token, { ...cookieOptions, httpOnly: true, maxAge: 30 * 24 * 60 * 60 });
    return { user: { id: user.id, email: user.email, name: user.name }, token, csrfToken: setCsrf(reply) };
  });
  app.get('/auth/me', { preHandler: auth }, async req => { const { id, email, name } = (req as typeof req & { session: { user: { id:string; email:string; name:string } } }).session.user; return { id, email, name }; });
  app.post('/auth/logout', { preHandler: auth }, async (req, reply) => {
    const session = (req as typeof req & { session: { id: string } }).session;
    await deps.prisma.session.delete({ where: { id: session.id } }); clearAuthCookies(reply); return reply.code(204).send();
  });
  app.delete('/auth/account', { preHandler: auth }, async (req, reply) => {
    const session = (req as typeof req & { session: { userId: string; id: string; user: { passwordHash?: string } } }).session;
    const body = parse(z.object({ password: z.string().min(1).max(128) }).strict(), req.body);
    const user = await deps.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || !await argon2.verify(user.passwordHash, body.password).catch(() => false)) throw Object.assign(new Error('Invalid password.'), { statusCode: 401 });
    await deps.prisma.user.delete({ where: { id: session.userId } }); clearAuthCookies(reply); return reply.code(204).send();
  });
  app.get('/accounts', { preHandler: auth }, async req => {
    const userId = (req as typeof req & { session: { userId: string } }).session.userId;
    const rows = await deps.prisma.account.findMany({ where: { userId, archivedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(({ id,name,type,currency,openingMinor }) => ({ id,name,type,currency,openingMinor:openingMinor.toString() }));
  });
  app.post('/accounts', { preHandler: auth }, async (req, reply) => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId, body=parse(accountSchema,req.body);
    const row=await deps.prisma.account.create({data:{...body,userId,openingMinor:BigInt(body.openingMinor)}});
    return reply.code(201).send({id:row.id,name:row.name,type:row.type,currency:row.currency,openingMinor:row.openingMinor.toString()});
  });
  app.put('/accounts/:id',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),body=parse(accountUpdateSchema,req.body),row=await deps.prisma.account.updateMany({where:{id,userId,archivedAt:null},data:body});if(!row.count)throw Object.assign(new Error('Account not found.'),{statusCode:404});return reply.code(204).send();});
  app.post('/accounts/:id/archive',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),row=await deps.prisma.account.updateMany({where:{id,userId,archivedAt:null},data:{archivedAt:new Date()}});if(!row.count)throw Object.assign(new Error('Account not found.'),{statusCode:404});return reply.code(204).send();});
  app.get('/accounts/:id/transactions',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),{limit,cursor}=parse(listSchema,req.query);return deps.prisma.transaction.findMany({where:{userId,OR:[{accountId:id},{toAccountId:id}]},orderBy:[{occurredAt:'desc'},{id:'desc'}],take:limit,...(cursor?{cursor:{id:cursor},skip:1}:{})}).then(rows=>rows.map(transactionView));});
  app.get('/transactions/export.csv',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,rows=await deps.prisma.transaction.findMany({where:{userId},orderBy:{occurredAt:'asc'},take:10000}),quote=(v:string)=>`\"${v.replaceAll('\"','\"\"')}\"`,csv=['id,type,date,description,amount_minor,currency,account_id,to_account_id,category_id',...rows.map(r=>[r.id,r.type,r.occurredAt.toISOString(),r.description,r.amountMinor.toString(),r.currency,r.accountId,r.toAccountId??'',r.categoryId??''].map(quote).join(','))].join('\r\n');return reply.header('content-type','text/csv; charset=utf-8').header('content-disposition','attachment; filename=\"kastren-transactions.csv\"').send(csv);});
  app.get('/transactions/:id',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),row=await deps.prisma.transaction.findFirst({where:{id,userId}});if(!row)throw Object.assign(new Error('Transaction not found.'),{statusCode:404});return transactionView(row);});
  app.post('/transactions/bulk-delete',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,ids=parse(z.array(uuidSchema).min(1).max(100),req.body);const result=await deps.prisma.transaction.deleteMany({where:{userId,id:{in:ids}}});return reply.send({deleted:result.count});});
  app.get('/categories/:id',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),row=await deps.prisma.category.findFirst({where:{id,userId}});if(!row)throw Object.assign(new Error('Category not found.'),{statusCode:404});return{id:row.id,name:row.name,type:row.type,archived:!!row.archivedAt};});
  app.put('/categories/:id',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),body=parse(categoryUpdateSchema,req.body);const result=await deps.prisma.category.updateMany({where:{id,userId,archivedAt:null},data:{name:body.name}});if(!result.count)throw Object.assign(new Error('Category not found.'),{statusCode:404});return reply.code(204).send();});
  app.post('/categories/:id/archive',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),result=await deps.prisma.category.updateMany({where:{id,userId,archivedAt:null},data:{archivedAt:new Date()}});if(!result.count)throw Object.assign(new Error('Category not found.'),{statusCode:404});return reply.code(204).send();});
  app.get('/budgets',{preHandler:auth},async(req)=>{
    const userId=(req as typeof req&{session:{userId:string}}).session.userId;
    const month=(req.query as{month?:string}).month??new Date().toISOString().slice(0,7);
    if(!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('Invalid month.'),{statusCode:400});
    const from=new Date(`${month}-01T00:00:00.000Z`),to=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,1));
    const budgets=await deps.prisma.budget.findMany({where:{userId,month},include:{category:{select:{name:true}}}});
    const expenses=await deps.prisma.transaction.findMany({where:{userId,type:'expense',occurredAt:{gte:from,lt:to}}});
    return budgets.map(b=>{
      const spent=expenses.filter(t=>t.categoryId===b.categoryId&&t.currency===b.currency).reduce((sum,t)=>sum+t.amountMinor,0n);
      return {id:b.id,categoryId:b.categoryId,category:b.category.name,currency:b.currency,month,limitMinor:b.limitMinor.toString(),spentMinor:spent.toString(),remainingMinor:(b.limitMinor-spent).toString(),percent:Number(spent*10000n/b.limitMinor)/100};
    });
  });
  app.post('/budgets',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,body=parse(budgetSchema,req.body),category=await deps.prisma.category.findFirst({where:{id:body.categoryId,userId,type:'expense',archivedAt:null},select:{id:true}});if(!category)throw Object.assign(new Error('Expense category not found.'),{statusCode:400});const row=await deps.prisma.budget.upsert({where:{userId_categoryId_month:{userId,categoryId:body.categoryId,month:body.month}},create:{...body,userId,limitMinor:BigInt(body.limitMinor)},update:{currency:body.currency,limitMinor:BigInt(body.limitMinor)}});return reply.code(201).send({...row,limitMinor:row.limitMinor.toString()});});
  app.get('/goals',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,rows=await deps.prisma.savingsGoal.findMany({where:{userId},include:{contributions:true},orderBy:{createdAt:'desc'}});return rows.map(g=>{const current=g.contributions.reduce((sum,c)=>sum+c.amountMinor,0n);return{id:g.id,name:g.name,currency:g.currency,targetMinor:g.targetMinor.toString(),currentMinor:current.toString(),progressPercent:Number(current*10000n/g.targetMinor)/100,targetDate:g.targetDate?.toISOString()??null};});});
  app.post('/goals',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,body=parse(goalSchema,req.body),row=await deps.prisma.savingsGoal.create({data:{...body,userId,targetMinor:BigInt(body.targetMinor),targetDate:body.targetDate?new Date(body.targetDate):null}});return reply.code(201).send({id:row.id,name:row.name,currency:row.currency,targetMinor:row.targetMinor.toString()});});
  app.post('/goals/:id/contributions',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),body=parse(contributionSchema,req.body);const row=await deps.prisma.$transaction(async tx=>{if(!await tx.savingsGoal.findFirst({where:{id,userId},select:{id:true}}))throw Object.assign(new Error('Goal not found.'),{statusCode:404});return tx.savingsContribution.create({data:{goalId:id,userId,amountMinor:BigInt(body.amountMinor),occurredAt:new Date(body.occurredAt)}});});return reply.code(201).send({...row,amountMinor:row.amountMinor.toString()});});
  app.get('/debts',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,rows=await deps.prisma.debt.findMany({where:{userId},include:{payments:true},orderBy:{dueAt:'asc'}});return rows.map(d=>{const paid=d.payments.reduce((sum,p)=>sum+p.amountMinor,0n);return{id:d.id,party:d.party,kind:d.kind,currency:d.currency,principalMinor:d.principalMinor.toString(),paidMinor:paid.toString(),remainingMinor:(d.principalMinor-paid).toString(),dueAt:d.dueAt?.toISOString()??null};});});
  app.post('/debts',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,body=parse(debtSchema,req.body),row=await deps.prisma.debt.create({data:{...body,userId,principalMinor:BigInt(body.principalMinor),dueAt:body.dueAt?new Date(body.dueAt):null}});return reply.code(201).send({id:row.id,party:row.party,kind:row.kind,principalMinor:row.principalMinor.toString(),currency:row.currency});});
  app.post('/debts/:id/payments',{preHandler:auth},async(req,reply)=>{const userId=(req as FastifyRequest&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),body=parse(paymentSchema,req.body),row=await deps.prisma.$transaction(async tx=>{const debt=await tx.debt.findFirst({where:{id,userId},include:{payments:true}});if(!debt)throw Object.assign(new Error('Debt not found.'),{statusCode:404});const paid=debt.payments.reduce((sum,p)=>sum+p.amountMinor,0n);if(BigInt(body.amountMinor)>debt.principalMinor-paid)throw Object.assign(new Error('Payment exceeds remaining balance.'),{statusCode:400});return tx.debtPayment.create({data:{debtId:id,userId,amountMinor:BigInt(body.amountMinor),occurredAt:new Date(body.occurredAt)}});});return reply.code(201).send({...row,amountMinor:row.amountMinor.toString()});});
  app.get('/recurring',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId;return(await deps.prisma.recurringTransaction.findMany({where:{userId},orderBy:{nextAt:'asc'}})).map(r=>({...r,amountMinor:r.amountMinor.toString()}));});
  app.post('/recurring',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,body=parse(recurringSchema,req.body);if(body.endsAt&&body.endsAt<body.startsAt)throw Object.assign(new Error('End date must follow start date.'),{statusCode:400});const [account,category]=await Promise.all([deps.prisma.account.findFirst({where:{id:body.accountId,userId,currency:body.currency,archivedAt:null},select:{id:true}}),deps.prisma.category.findFirst({where:{id:body.categoryId,userId,type:body.type,archivedAt:null},select:{id:true}})]);if(!account||!category)throw Object.assign(new Error('Account or category not found.'),{statusCode:400});const startsAt=new Date(body.startsAt),row=await deps.prisma.recurringTransaction.create({data:{...body,userId,amountMinor:BigInt(body.amountMinor),startsAt,endsAt:body.endsAt?new Date(body.endsAt):null,nextAt:startsAt}});return reply.code(201).send({...row,amountMinor:row.amountMinor.toString()});});
  app.post('/recurring/:id/toggle',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as{id:string}).id),row=await deps.prisma.recurringTransaction.findFirst({where:{id,userId}});if(!row)throw Object.assign(new Error('Recurring transaction not found.'),{statusCode:404});await deps.prisma.recurringTransaction.update({where:{id},data:{active:!row.active}});return reply.code(204).send();});
  app.get('/reports/cashflow',{preHandler:auth},async(req)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,q=parse(z.object({start:z.string().datetime(),end:z.string().datetime(),currency:z.string().regex(/^[A-Z]{3}$/)}).strict().refine(v=>v.start<=v.end),req.query),rows=await deps.prisma.transaction.groupBy({by:['type'],where:{userId,currency:q.currency,occurredAt:{gte:new Date(q.start),lte:new Date(q.end)},type:{in:['income','expense']}},_sum:{amountMinor:true}});return{currency:q.currency,start:q.start,end:q.end,incomeMinor:(rows.find(r=>r.type==='income')?._sum.amountMinor??0n).toString(),expenseMinor:(rows.find(r=>r.type==='expense')?._sum.amountMinor??0n).toString()};});
  app.get('/reports/export.csv',{preHandler:auth},async(req,reply)=>{const userId=(req as typeof req&{session:{userId:string}}).session.userId,q=parse(z.object({start:z.string().datetime().optional(),end:z.string().datetime().optional()}).strict().refine(v=>!v.start||!v.end||v.start<=v.end),req.query),rows=await deps.prisma.transaction.findMany({where:{userId,...(q.start||q.end?{occurredAt:{...(q.start?{gte:new Date(q.start)}:{}),...(q.end?{lte:new Date(q.end)}:{})}}:{})},orderBy:{occurredAt:'asc'},take:10000}),quote=(v:string)=>`\"${v.replaceAll('\"','\"\"')}\"`,csv=['id,type,date,description,amount_minor,currency,account_id,to_account_id,category_id',...rows.map(r=>[r.id,r.type,r.occurredAt.toISOString(),r.description,r.amountMinor.toString(),r.currency,r.accountId,r.toAccountId??'',r.categoryId??''].map(quote).join(','))].join('\r\n');return reply.header('content-type','text/csv; charset=utf-8').header('content-disposition','attachment; filename=\"kastren-transactions.csv\"').send(csv);});
  app.get('/reports/monthly',{preHandler:auth},async(req)=>{const userId=(req as FastifyRequest&{session:{userId:string}}).session.userId,q=parse(z.object({start:z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),months:z.coerce.number().int().min(1).max(36).default(12),currency:z.string().regex(/^[A-Z]{3}$/)}).strict(),req.query),start=new Date(`${q.start}-01T00:00:00Z`),end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+q.months,1)),rows=await deps.prisma.transaction.groupBy({by:['type','occurredAt'],where:{userId,currency:q.currency,type:{in:['income','expense']},occurredAt:{gte:start,lt:end}},_sum:{amountMinor:true}});const months=new Map<string,{income:bigint;expense:bigint}>();for(let i=0;i<q.months;i++){const d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+i,1));months.set(d.toISOString().slice(0,7),{income:0n,expense:0n});}for(const r of rows){const key=r.occurredAt.toISOString().slice(0,7),v=months.get(key);if(v)v[r.type as'income'|'expense']+=r._sum.amountMinor??0n;}return[...months].map(([month,v])=>({month,currency:q.currency,incomeMinor:v.income.toString(),expenseMinor:v.expense.toString(),netMinor:(v.income-v.expense).toString()}));});
  app.post('/categories', { preHandler: auth }, async (req,reply) => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId, body=parse(categorySchema,req.body);
    const row=await deps.prisma.category.create({data:{...body,userId}}); return reply.code(201).send({id:row.id,name:row.name,type:row.type});
  });
  app.get('/categories', { preHandler: auth }, async req => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId;
    return deps.prisma.category.findMany({where:{userId,archivedAt:null},orderBy:[{type:'asc'},{name:'asc'}],select:{id:true,name:true,type:true}});
  });
  app.post('/transactions', { preHandler: auth }, async (req,reply) => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId, body=parse(transactionSchema,req.body);
    const created=await deps.prisma.$transaction(async tx=>{
      const accounts=await tx.account.findMany({where:{userId,id:{in:[body.accountId,...(body.toAccountId?[body.toAccountId]:[])]},archivedAt:null},select:{id:true,currency:true}});
      if(accounts.length !== (body.type==='transfer'?2:1) || accounts.some(a=>a.currency !== body.currency)) throw Object.assign(new Error('Account is missing or currency does not match.'),{statusCode:400});
      if(body.categoryId){const category=await tx.category.findFirst({where:{id:body.categoryId,userId,type:body.type,archivedAt:null},select:{id:true}});if(!category)throw Object.assign(new Error('Category is missing or does not match transaction type.'),{statusCode:400});}
      return tx.transaction.create({data:{...body,userId,amountMinor:BigInt(body.amountMinor),occurredAt:new Date(body.occurredAt),notes:body.notes??null}});
    });
    return reply.code(201).send(transactionView(created));
  });
  app.get('/transactions', { preHandler: auth }, async req => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId;
    const {cursor,limit,start,end,type,accountId,categoryId}=parse(listSchema,req.query);
    const rows=await deps.prisma.transaction.findMany({where:{userId,...(type?{type}:{}),...(categoryId?{categoryId}:{}),...(accountId?{OR:[{accountId},{toAccountId:accountId}]}:{}),...(start||end?{occurredAt:{...(start?{gte:new Date(start)}:{}),...(end?{lte:new Date(end)}:{})}}:{})},orderBy:[{occurredAt:'desc'},{id:'desc'}],take:limit+1,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    const more=rows.length>limit; const page=rows.slice(0,limit);
    return {data:page.map(transactionView),nextCursor:more?page.at(-1)?.id??null:null};
  });
  app.put('/transactions/:id', { preHandler: auth }, async (req,reply) => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId, id=parse(uuidSchema,(req.params as {id:string}).id), body=parse(transactionSchema,req.body);
    const updated=await deps.prisma.$transaction(async tx=>{
      const accounts=await tx.account.findMany({where:{userId,id:{in:[body.accountId,...(body.toAccountId?[body.toAccountId]:[])]},archivedAt:null},select:{id:true,currency:true}});
      if(accounts.length !== (body.type==='transfer'?2:1) || accounts.some(a=>a.currency!==body.currency)) throw Object.assign(new Error('Account is missing or currency does not match.'),{statusCode:400});
      if(body.categoryId && !await tx.category.findFirst({where:{id:body.categoryId,userId,type:body.type,archivedAt:null},select:{id:true}})) throw Object.assign(new Error('Category is missing or does not match transaction type.'),{statusCode:400});
      const result=await tx.transaction.updateMany({where:{id,userId},data:{...body,toAccountId:body.type==='transfer'?(body.toAccountId??null):null,categoryId:body.type==='transfer'?null:(body.categoryId??null),amountMinor:BigInt(body.amountMinor),occurredAt:new Date(body.occurredAt),notes:body.notes??null}});
      if(!result.count) throw Object.assign(new Error('Transaction not found.'),{statusCode:404});
      return tx.transaction.findFirstOrThrow({where:{id,userId}});
    }); return reply.send(transactionView(updated));
  });
  app.delete('/transactions/:id', { preHandler: auth }, async (req,reply) => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId,id=parse(uuidSchema,(req.params as {id:string}).id);
    const result=await deps.prisma.transaction.deleteMany({where:{id,userId}}); if(!result.count)throw Object.assign(new Error('Transaction not found.'),{statusCode:404}); return reply.code(204).send();
  });
  app.get('/dashboard/summary', { preHandler: auth }, async req => {
    const userId=(req as typeof req & {session:{userId:string}}).session.userId;
    const rows=await deps.prisma.transaction.findMany({where:{userId},orderBy:{occurredAt:'desc'}});
    const now=new Date(); const month=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}`;
    const balances=new Map<string,{currency:string;minor:bigint}>();
    for(const account of await deps.prisma.account.findMany({where:{userId},select:{id:true,currency:true,openingMinor:true}})) balances.set(account.id,{currency:account.currency,minor:account.openingMinor});
    const cashFlow=new Map<string,{income:bigint;expense:bigint}>();
    const categories=new Map<string,bigint>();
    for(const row of rows){
      const source=balances.get(row.accountId);
      if(!source||source.currency!==row.currency)throw Object.assign(new Error('Invalid source account or currency in ledger.'),{statusCode:500});
      if(row.type==='income'){source.minor+=row.amountMinor;if(row.occurredAt.toISOString().startsWith(month)){const flow=cashFlow.get(row.currency)??{income:0n,expense:0n};flow.income+=row.amountMinor;cashFlow.set(row.currency,flow);}}
      if(row.type==='expense'){source.minor-=row.amountMinor;if(row.occurredAt.toISOString().startsWith(month)){const flow=cashFlow.get(row.currency)??{income:0n,expense:0n};flow.expense+=row.amountMinor;cashFlow.set(row.currency,flow);const key=`${row.currency}:${row.categoryId??'uncategorized'}`;categories.set(key,(categories.get(key)??0n)+row.amountMinor);}}
      if(row.type==='transfer'){const destination=balances.get(row.toAccountId??'');if(!destination||!source||destination.currency!==source.currency||row.currency!==source.currency)throw Object.assign(new Error('Invalid transfer ledger record.'),{statusCode:500});source.minor-=row.amountMinor;destination.minor+=row.amountMinor;}
    }
    const categoryIds=[...categories.keys()].map(x=>x.split(':',2)[1]).filter((x):x is string=>!!x&&x!=='uncategorized');
    const categoryRows=categoryIds.length?await deps.prisma.category.findMany({where:{id:{in:categoryIds},userId},select:{id:true,name:true}}):[];
    return {balances:[...balances].map(([accountId,b])=>({accountId,currency:b.currency,balanceMinor:b.minor.toString()})),cashFlowByCurrency:[...cashFlow].map(([currency,v])=>({currency,incomeMinor:v.income.toString(),expenseMinor:v.expense.toString(),netCashFlowMinor:(v.income-v.expense).toString()})),expenseByCategory:[...categories].map(([key,amount])=>{const [currency,id]=key.split(':');return{currency,categoryId:id==='uncategorized'?null:id,name:id==='uncategorized'?'Uncategorized':categoryRows.find(c=>c.id===id)?.name??'Unknown',amountMinor:amount.toString()};})};
  });
  return app;
}
