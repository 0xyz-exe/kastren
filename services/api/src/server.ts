import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { buildApp } from './app.js';
import { createMailAdapter } from './mailer.js';

const url = process.env.DATABASE_URL;
const secret = process.env.SESSION_SECRET;
if (!url || !secret) throw new Error('DATABASE_URL and SESSION_SECRET are required.');
const port = Number(process.env.API_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT must be a valid port.');
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
const sendResetEmail = createMailAdapter(webOrigin);
const pool = new Pool({ connectionString: url });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
const app = await buildApp({
  prisma,
  sessionSecret: secret,
  webOrigin,
  secureCookies: process.env.NODE_ENV === 'production',
  production: process.env.NODE_ENV === 'production',
  sendResetEmail
});
const host = process.env.API_HOST ?? '0.0.0.0';
try {
  await prisma.$connect();
  await app.listen({ port, host });
  app.log.info(`Kastren API listening on ${host}:${port}`);
} catch (error) {
  app.log.error(error);
  await app.close();
  await prisma.$disconnect();
  await pool.end();
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void app.close().finally(async () => { await prisma.$disconnect(); await pool.end(); }));
