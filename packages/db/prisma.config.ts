import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` does not connect, so an unset URL is fine there; migrate commands need it.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
