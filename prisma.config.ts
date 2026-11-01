import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'services/api/prisma/schema.prisma',
  migrations: {
    path: 'services/api/prisma/migrations',
    seed: 'tsx services/api/prisma/seed.ts',
  },
  datasource: { url: env('DATABASE_URL') },
});
