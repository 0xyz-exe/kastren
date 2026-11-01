#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sessionSecret = crypto.randomBytes(48).toString('base64url');
const dbPassword = crypto.randomBytes(24).toString('base64url');

const template = `# Kastren Production Environment Configuration
# Generated on: ${new Date().toISOString()}
# Strict Rule: Keep this file private. Never commit to git or expose in logs.

NODE_ENV=production
API_PORT=3000

# Strong Random Secrets (Generated with crypto.randomBytes)
SESSION_SECRET=${sessionSecret}
POSTGRES_PASSWORD=${dbPassword}

# Set your exact public HTTPS frontend domain
WEB_ORIGIN=https://kastren.example.com

# PostgreSQL Connection String (used by API container internally)
DATABASE_URL=postgresql://kastren:${encodeURIComponent(dbPassword)}@db:5432/kastren?schema=public
`;

const targetPath = path.resolve(process.cwd(), 'deploy/.env.production');
if (fs.existsSync(targetPath)) {
  console.log(`[INFO] deploy/.env.production already exists at: ${targetPath}`);
  console.log('To regenerate, delete or back up the existing file first.');
} else {
  fs.writeFileSync(targetPath, template, { mode: 0o600 });
  console.log(`[SUCCESS] Generated production secrets in: ${targetPath}`);
  console.log('Review deploy/.env.production and set your real WEB_ORIGIN domain before deploying.');
}
