import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let server: Server;
let base: string;
let agentToken: string;

before(async () => {
  env = await setup();
  const { app } = await createApp(env.db, { publicUrl: 'http://test.local' });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const globex = await env.k.createEntity(env.admin, { type: 'organization', name: 'Globex', summary: 'Prospect for the billing integration.', tier: 2 });
  await env.k.perform(env.admin, globex.id, 'add_observation', { content: 'Globex wants usage-based pricing, capped at 40k a year.', tier: 2 });
  await env.k.perform(env.admin, globex.id, 'add_observation', { content: 'Their CTO prefers Slack over email.', tier: 4 });
  await env.k.createEntity(env.admin, { type: 'project', name: 'Warehouse migration', summary: 'Moving reporting to the new warehouse.' });
  const sam = await env.addUser('sam@example.com');
  agentToken = (await env.addToken(sam.id, 'agent', 4)).token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await env.close();
});

const hook = (body: unknown, token = agentToken) =>
  fetch(`${base}/hooks/claude-code`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('the recall tool returns plain-text context for a prompt about a known entity, and nothing otherwise', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } }));
  const call = async (text: string) => ((await client.callTool({ name: 'recall', arguments: { text } })) as { content: { text: string }[] }).content[0].text;

  const hit = await call('Draft a reply to Globex about where we landed on pricing');
  assert.ok(!hit.startsWith('{'), 'hooks parse output starting with { as JSON control');
  assert.match(hit, /Globex \(organization, Verified, owner admin\)/);
  assert.match(hit, /\[Verified\] Globex wants usage-based pricing/);
  assert.doesNotMatch(hit, /Warehouse migration/);

  assert.equal(await call('Refactor this loop to use map instead of a for statement'), '');
  assert.match(await call('how is the warehouse reporting migration going'), /Warehouse migration/, 'keywords alone are enough when several match');

  const logged = await env.db.query<{ via: string; n: number }>('select via, cardinality(entity_ids) as n from recall_log order by id');
  assert.deepEqual(logged.rows, [
    { via: 'tool', n: 1 },
    { via: 'tool', n: 1 },
  ]);
  await client.close();
});

test('the Claude Code hook endpoint adds context on SessionStart and UserPromptSubmit', async () => {
  assert.equal((await hook({ hook_event_name: 'SessionStart' }, 'nope')).status, 401);

  const start = await hook({ hook_event_name: 'SessionStart', cwd: '/Users/sam/code/globex-billing', session_id: 's1' });
  assert.equal(start.status, 200);
  const started = (await start.json()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(started.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(started.hookSpecificOutput.additionalContext, /connected as sam \(agent, writes up to Raw directly\)/);
  assert.match(started.hookSpecificOutput.additionalContext, /Globex/, 'the project folder name pulls in related context');

  const prompt = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'What does the Globex CTO prefer for updates?' });
  const prompted = (await prompt.json()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(prompted.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompted.hookSpecificOutput.additionalContext, /\[Raw\] Their CTO prefers Slack/);

  for (const body of [
    { hook_event_name: 'UserPromptSubmit', prompt: '/compact' },
    { hook_event_name: 'UserPromptSubmit', prompt: 'Rename this variable to something clearer please' },
    { hook_event_name: 'Stop' },
  ]) {
    const res = await hook(body);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '', `${JSON.stringify(body)} adds nothing`);
  }
});
