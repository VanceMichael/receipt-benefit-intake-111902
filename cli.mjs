#!/usr/bin/env node
// 业务员命令行入口：
//   node cli.mjs run --campaign W26 --business-day 2026-11-19
//   node cli.mjs supplement --business-day 2026-11-19
//   node cli.mjs show RUN-001
//   node cli.mjs trace RUN-001 "双栖书屋|M8|2026-11-19|3|1"
//   node cli.mjs pending
import { createApp } from './lib/app.mjs';

const baseUrl = process.env.APP_URL || 'http://127.0.0.1:3200';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        args[name] = true;
      } else {
        args[name] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(payload));
  return payload;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const scope = {};
  if (args['campaign']) scope.campaign = args['campaign'];
  if (args['business-day']) scope.businessDay = args['business-day'];
  if (args['merchants']) scope.merchants = String(args['merchants']).split(',');

  let result;
  switch (command) {
    case 'run':
      result = await request('/reconciliations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(scope),
      });
      break;
    case 'supplement':
      result = await request('/supplements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(scope),
      });
      break;
    case 'show':
      result = await request('/runs/' + encodeURIComponent(args._[0]));
      break;
    case 'trace': {
      const [runId, key] = args._;
      result = await request('/runs/' + encodeURIComponent(runId) +
        '/lines/' + encodeURIComponent(key));
      break;
    }
    case 'pending':
      result = await request('/pending');
      break;
    default:
      console.error('用法: run | supplement | show <runId> | trace <runId> <lineKey> | pending');
      process.exitCode = 1;
      return;
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
