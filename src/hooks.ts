import express, { type Request, type Response } from 'express';
import type { Knowledge } from './services/knowledge.js';
import { recall } from './services/recall.js';
import type { Actor } from './types.js';

type Authenticate = (req: Request) => Promise<Actor | null>;

interface HookInput {
  hook_event_name?: string;
  prompt?: string;
  cwd?: string;
  session_title?: string;
}

const context = (event: string, additionalContext: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext } });

/**
 * Claude Code HTTP hooks (https://code.claude.com/docs/en/hooks). The body is the hook's JSON input and the
 * response uses the hook JSON output format. An empty 200 means "nothing to add".
 */
export function hooksRouter(k: Knowledge, authenticate: Authenticate): express.Router {
  const r = express.Router();

  r.post('/hooks/claude-code', express.json({ limit: '256kb' }), async (req: Request, res: Response) => {
    const actor = await authenticate(req);
    if (!actor) {
      res.status(401).json({ error: 'Missing or invalid token' });
      return;
    }
    const input = (req.body ?? {}) as HookInput;

    if (input.hook_event_name === 'SessionStart') {
      const { rows } = await k.db.query<{ waiting: string; unread: string }>(
        `select (select count(*) from change_requests where assignee_id = $1 and status = 'open') as waiting,
                (select count(*) from notifications where user_id = $1 and read_at is null) as unread`,
        [actor.userId],
      );
      const project = [input.session_title, input.cwd?.split(/[\\/]/).filter(Boolean).pop()].filter(Boolean).join(' ');
      const related = project ? await recall(k, actor, { text: project, via: 'hook', limit: 3 }) : null;
      const lines = [
        `Commonplace, the team's knowledge graph, is connected as ${actor.name} (${actor.tokenKind}, writes up to ${k.tierName(actor.ceiling)} directly).`,
        'Check it with recall or search_knowledge before answering questions about the team, clients, projects or past decisions, and record what you learn with a source.',
      ];
      const waiting = Number(rows[0].waiting);
      const unread = Number(rows[0].unread);
      if (waiting) lines.push(`${waiting} change request${waiting === 1 ? ' is' : 's are'} waiting on ${actor.name}. list_requests shows them.`);
      if (unread) lines.push(`${unread} unread notification${unread === 1 ? '' : 's'} in inbox.`);
      if (related?.text) lines.push('', related.text);
      res.json(context('SessionStart', lines.join('\n')));
      return;
    }

    if (input.hook_event_name === 'UserPromptSubmit') {
      const prompt = (input.prompt ?? '').trim();
      if (prompt.length < 12 || prompt.startsWith('/')) {
        res.status(200).end();
        return;
      }
      const found = await recall(k, actor, { text: prompt, via: 'hook' });
      if (!found.text) {
        res.status(200).end();
        return;
      }
      res.json(context('UserPromptSubmit', found.text));
      return;
    }

    res.status(200).end();
  });

  return r;
}
