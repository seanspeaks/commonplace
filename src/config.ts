function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const publicUrl = (process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const oauthEnabled = process.env.OAUTH_ENABLED === 'true';
const { protocol, hostname } = new URL(publicUrl);
if (oauthEnabled && protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
  throw new Error(`OAUTH_ENABLED needs an https public URL (or localhost for development). Got ${publicUrl}; set PUBLIC_URL.`);
}

const { DREAM_LLM_BASE_URL, DREAM_LLM_MODEL, DREAM_LLM_API_KEY } = process.env;

export const config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  publicUrl,
  publicUrlIsSet: Boolean(process.env.PUBLIC_URL ?? process.env.RENDER_EXTERNAL_URL),
  dreamLlm: DREAM_LLM_BASE_URL && DREAM_LLM_MODEL ? { baseUrl: DREAM_LLM_BASE_URL, model: DREAM_LLM_MODEL, apiKey: DREAM_LLM_API_KEY || undefined } : null,
  oauthEnabled,
  adminEmail: process.env.ADMIN_EMAIL,
  adminToken: process.env.ADMIN_TOKEN,
  notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || undefined,
};
