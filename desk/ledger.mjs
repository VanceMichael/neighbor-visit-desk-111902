// 本地台账：记录两边门户各自看到的哪一条、已执行与未执行的动作。
// 街道结果不可核实时，分项停在人能接手的位置；同一服务单其他分项照常推进。
// 台账只作经办留痕，互助站页面的撤销标记仍以街道撤销确立为前提。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEDGER_VERSION = 1;

export async function loadLedger(file) {
  try {
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== LEDGER_VERSION) {
      throw new Error(`台账版本 ${parsed.version} 与当前 ${LEDGER_VERSION} 不一致`);
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { version: LEDGER_VERSION, groups: {}, runs: [] };
    }
    throw error;
  }
}

export async function saveLedger(file, ledger) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ledger, null, 2) + '\n');
}

export function groupEntry(ledger, key) {
  if (!ledger.groups[key]) {
    ledger.groups[key] = {
      key,
      visit: null,
      resident: null,
      date: null,
      period: null,
      items: [],
      sheets: [],
      register: null,
      revoke: null,
      stationConfirms: {},
      handoff: null,
      history: [],
    };
  }
  return ledger.groups[key];
}

export function appendHistory(entry, event) {
  entry.history.push({ at: new Date().toISOString(), ...event });
}

// 人工接手条目：写清楚两边看到的记录、卡点和尚未执行的动作。
export function setHandoff(entry, reason, portalEvidence, pendingActions) {
  entry.handoff = {
    open: true,
    reason,
    portalEvidence,
    pendingActions,
    openedAt: new Date().toISOString(),
  };
}

export function clearHandoff(entry) {
  if (entry.handoff) entry.handoff.open = false;
}

// 面向经办人的 Markdown 报告。
export function renderReport(ledger) {
  const lines = [
    '# 助老探访代办台账',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
  ];
  const entries = Object.values(ledger.groups);
  if (entries.length === 0) {
    lines.push('本次没有处理任何探访分组。', '');
    return lines.join('\n');
  }
  const openHandoffs = entries.filter(entry => entry.handoff?.open);
  lines.push(`## 人工接手（${openHandoffs.length} 项）`, '');
  if (openHandoffs.length === 0) lines.push('无。', '');
  for (const entry of openHandoffs) {
    lines.push(`### 探访 ${entry.visit}｜${entry.date} ${entry.period}｜${entry.items.join('、')}`);
    lines.push(`- 卡点：${entry.handoff.reason}`);
    lines.push('- 门户可见依据：');
    for (const evidence of entry.handoff.portalEvidence) lines.push(`  - ${evidence}`);
    lines.push('- 尚未执行的动作：');
    for (const action of entry.handoff.pendingActions) lines.push(`  - ${action}`);
    lines.push('');
  }
  lines.push('## 各探访分组明细', '');
  for (const entry of entries) {
    lines.push(`### ${entry.visit}｜${entry.resident}｜${entry.date} ${entry.period}`);
    lines.push(`- 分项：${entry.items.join('、')}`);
    lines.push(`- 服务单：${entry.sheets.map(sheet => `${sheet.sheet}（${sheet.station}，${sheet.status}）`).join('、')}`);
    lines.push(`- 街道登记：${describeRegister(entry)}`);
    lines.push(`- 街道撤销：${entry.revoke ? describeRevoke(entry.revoke) : '未发起'}`);
    const confirms = Object.values(entry.stationConfirms);
    if (confirms.length === 0) {
      lines.push('- 互助站回填：无（街道办理号可核实后才回填）');
    } else {
      lines.push('- 互助站回填：');
      for (const confirm of confirms) {
        lines.push(`  - 服务单 ${confirm.stationSheet}：${confirm.state}（互助站经办号 ${confirm.requestKey}${confirm.receipt ? `，街道办理号 ${confirm.receipt}` : ''}）`);
      }
    }
    lines.push('');
  }
  lines.push('## 动作时间线', '');
  for (const entry of entries) {
    for (const event of entry.history) {
      lines.push(`- ${event.at}｜${entry.visit}｜${event.action}${event.detail ? '｜' + event.detail : ''}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function describeRegister(entry) {
  const register = entry.register;
  if (!register) return '未提交';
  if (register.state === '已受理') return `已受理，办理号 ${register.receipt}（经办号 ${register.requestKey}）`;
  return `状态「${register.state}」，经办号 ${register.requestKey}，回执暂不可核实`;
}

function describeRevoke(revoke) {
  if (revoke.state === '已受理') return `已受理，办理号 ${revoke.receipt}（原办理号 ${revoke.priorReceipt}）`;
  return `状态「${revoke.state}」（原办理号 ${revoke.priorReceipt}）`;
}
