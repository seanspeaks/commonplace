import type { Db, Queryable } from '../db.js';

export interface NewNotification {
  userId: string;
  kind: 'request.created' | 'request.resolved' | 'entity.changed' | 'entity.transferred';
  title: string;
  body?: string;
  link?: string;
  requestId?: string;
}

export async function notify(db: Queryable, n: NewNotification): Promise<void> {
  await db.query(
    `insert into notifications (user_id, kind, title, body, link, change_request_id) values ($1, $2, $3, $4, $5, $6)`,
    [n.userId, n.kind, n.title, n.body ?? '', n.link ?? null, n.requestId ?? null],
  );
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  change_request_id: string | null;
  read_at: Date | null;
  created_at: Date;
}

export async function listNotifications(db: Queryable, userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  const { rows } = await db.query<NotificationRow>(
    `select id, kind, title, body, link, change_request_id, read_at, created_at from notifications
     where user_id = $1 and ($2::boolean is false or read_at is null)
     order by created_at desc limit $3`,
    [userId, opts.unreadOnly ?? false, opts.limit ?? 50],
  );
  return rows;
}

export async function markRead(db: Queryable, userId: string, ids: string[] | 'all'): Promise<number> {
  const result =
    ids === 'all'
      ? await db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [userId])
      : await db.query('update notifications set read_at = now() where user_id = $1 and id = any($2) and read_at is null', [userId, ids]);
  return result.rowCount ?? 0;
}

const MAX_ATTEMPTS = 5;

/**
 * Pushes pending notifications to the user's webhook, or the team-wide one.
 * The payload's `text` field makes it work as a Slack incoming webhook out of the box.
 */
export async function deliverPending(db: Db, globalWebhookUrl: string | undefined): Promise<number> {
  const client = await db.connect();
  let delivered = 0;
  try {
    await client.query('begin');
    const { rows } = await client.query<NotificationRow & { user_email: string; user_webhook: string | null }>(
      `select n.*, u.email as user_email, u.notify_webhook_url as user_webhook
       from notifications n join users u on u.id = n.user_id
       where n.delivered_at is null and n.delivery_attempts < $1
       order by n.created_at limit 25 for update of n skip locked`,
      [MAX_ATTEMPTS],
    );
    for (const n of rows) {
      const url = n.user_webhook ?? globalWebhookUrl;
      if (!url) {
        await client.query('update notifications set delivered_at = now() where id = $1', [n.id]);
        continue;
      }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: [`*${n.title}*`, n.body, n.link].filter(Boolean).join('\n'),
            kind: n.kind,
            to: n.user_email,
            title: n.title,
            body: n.body,
            link: n.link,
            change_request_id: n.change_request_id,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await client.query('update notifications set delivered_at = now(), delivery_attempts = delivery_attempts + 1 where id = $1', [n.id]);
        delivered++;
      } catch (err) {
        await client.query('update notifications set delivery_attempts = delivery_attempts + 1, last_error = $2 where id = $1', [
          n.id,
          (err as Error).message,
        ]);
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return delivered;
}

export function startDispatcher(db: Db, globalWebhookUrl: string | undefined, intervalMs = 5_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await deliverPending(db, globalWebhookUrl);
    } catch (err) {
      console.error('Notification dispatch failed:', err);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
