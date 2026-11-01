import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const defaults = {
  expense: ['Food & Drinks', 'Transportation', 'Shopping', 'Bills', 'Housing', 'Healthcare', 'Education', 'Entertainment', 'Subscriptions', 'Travel', 'Other'],
  income: ['Salary', 'Freelance', 'Business', 'Investment Income', 'Gift', 'Other'],
};

async function main() {
  const count = await prisma.user.count();
  if (count === 0) return;
  for (const user of await prisma.user.findMany({ select: { id: true } })) {
    for (const type of ['income', 'expense'] as const) {
      await prisma.category.createMany({ data: defaults[type].map(name => ({ userId: user.id, name, type })), skipDuplicates: true });
    }
  }
}

main().finally(() => prisma.$disconnect());
