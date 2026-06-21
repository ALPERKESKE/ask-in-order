#!/usr/bin/env node
// Smoke test: spawn the MCP server over stdio and exercise every tool.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const parse = (r) => JSON.parse(r.content[0].text);
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) fail++; };

const transport = new StdioClientTransport({
  command: 'node', args: [path.join(HERE, 'server.mjs')],
  env: { ...process.env, AIO_TELEMETRY: path.join(HERE, 'telemetry.test.jsonl') },
});
const client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`\ntools/list → ${tools.map((t) => t.name).join(', ')}`);
ok(tools.length === 5, '5 tools advertised');

console.log('\nlist_paths');
const paths = parse(await client.callTool({ name: 'list_paths', arguments: {} }));
ok(paths.length >= 4, `${paths.length} paths`);
ok(paths.some((p) => p.topic === 'splunk' && p.steps === 22), 'splunk has 22 steps');

console.log('\nstart_path splunk');
const start = parse(await client.callTool({ name: 'start_path', arguments: { topic: 'splunk' } }));
ok(!!start.tutor_guidance, 'returns tutor_guidance');
ok(start.outline.length === 6, `${start.outline.length} modules in outline`);
ok(start.first_step?.slug === 'what-is-splunk', `first step = ${start.first_step?.slug}`);
ok(!!start.first_step?.teaching_plan, 'first step carries teaching_plan');
const firstId = start.first_step.id;
const secondId = start.first_step.next_id;
ok(!!secondId, `first.next_id present (${secondId})`);

console.log('\nget_step (by slug)');
const gs = parse(await client.callTool({ name: 'get_step', arguments: { topic: 'splunk', step_id: 'stats-essentials' } }));
ok(gs.title.includes('stats'), `loaded "${gs.title}"`);
ok(!!gs.quiz && !!gs.practice, 'has quiz + practice');

console.log('\nnext_step');
const ns = parse(await client.callTool({ name: 'next_step', arguments: { topic: 'splunk', after_id: firstId } }));
ok(ns.id === secondId, `advanced to next (${ns.slug})`);

console.log('\nreport_stuck → telemetry');
const rs = parse(await client.callTool({ name: 'report_stuck', arguments: { topic: 'splunk', step_id: firstId, note: 'smoke-test stuck signal' } }));
ok(rs.ok === true, 'stuck logged');

console.log('\nerror path (unknown topic)');
const err = await client.callTool({ name: 'start_path', arguments: { topic: 'nope' } });
ok(err.isError === true, 'unknown topic returns isError');

await client.close();
console.log(`\n${fail === 0 ? '✅ ALL PASS' : `❌ ${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
