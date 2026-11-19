// 代办命令行入口：
// node desk/agent.mjs --origin http://127.0.0.1:3100 [--request requests/example.json]
//                          [--state-dir .desk] [--headless]

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runDesk } from './run.mjs';

const { values } = parseArgs({
  options: {
    origin: { type: 'string', default: process.env.ORIGIN ?? 'http://127.0.0.1:3100' },
    request: { type: 'string' },
    'state-dir': { type: 'string', default: '.desk' },
  },
});

const request = values.request
  ? JSON.parse(await readFile(resolve(values.request), 'utf8'))
  : null;

const stateDir = resolve(values['state-dir']);
const result = await runDesk({
  origin: values.origin.replace(/\/$/, ''),
  ledgerFile: resolve(stateDir, 'ledger.json'),
  reportFile: resolve(stateDir, 'report.md'),
  request,
});

console.log(`代办完成：人工接手 ${result.handoffCount} 项`);
console.log(`台账：${resolve(stateDir, 'ledger.json')}`);
console.log(`报告：${resolve(stateDir, 'report.md')}`);
