function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  publicUrl: (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  adminEmail: process.env.ADMIN_EMAIL,
  adminToken: process.env.ADMIN_TOKEN,
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || undefined,
};
