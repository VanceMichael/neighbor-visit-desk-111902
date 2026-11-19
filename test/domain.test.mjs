import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeStationRows,
  normalizeConsentRows,
  normalizeStreetRows,
  groupVisits,
  evaluateConsent,
  resolveCredential,
  findStreetConflict,
  registrationRequestKey,
  revokeRequestKey,
  stationConfirmRequestKey,
  windowCovers,
} from '../desk/domain.mjs';

const stationRows = normalizeStationRows([
  { 站点: '西桥站', 服务单: 'X3', 老人编号: 'N-3', 共同探访: 'V-12', 代签人: 'P-9', 分项: '代取', 日期: '2026-11-19', 时段: '09:00—09:20', 状态: '已确认' },
  { 站点: '西桥站', 服务单: 'X4', 老人编号: 'N-3', 共同探访: 'V-12', 代签人: 'P-9', 分项: '代取', 日期: '2026-11-19', 时段: '09:00—09:20', 状态: '已确认' },
  { 站点: '东桥站', 服务单: 'E4', 老人编号: 'N-3', 共同探访: 'V-13', 代签人: 'P-9', 分项: '陪诊', 日期: '2026-11-19', 时段: '11:30—12:10', 状态: '待签署' },
]);

const consentPhase0 = normalizeConsentRows([
  { 老人编号: 'N-3', 代签人: 'P-9', 适用事项: '代取、陪诊', 起止时刻: '08:00—12:30', 连续服务凭证: 'PAX-9' },
]);
const consentPhase1 = normalizeConsentRows([
  { 老人编号: 'N-3', 代签人: 'P-9', 适用事项: '陪诊', 起止时刻: '10:30—12:30', 连续服务凭证: 'PAX-9' },
]);

const streetRows = normalizeStreetRows([
  { 老人编号: 'N-3', 探访编号: 'V-10', 类别: '助餐', 日期: '2026-11-19', 办理号: 'J-08' },
]);

test('双人记录按共同探访编号与实际时段合并为同一次探访', () => {
  const groups = groupVisits(stationRows);
  assert.equal(groups.length, 2);
  const v12 = groups.find(group => group.visit === 'V-12');
  assert.deepEqual(v12.sheets.map(sheet => sheet.sheet), ['X3', 'X4']);
  assert.equal(v12.crossStation, false);
  const v13 = groups.find(group => group.visit === 'V-13');
  assert.equal(v13.crossStation, true);
});

test('授权窗口覆盖判断只在事项与时刻同时满足时成立', () => {
  assert.equal(windowCovers('08:00—12:30', '09:00—09:20'), true);
  assert.equal(windowCovers('10:30—12:30', '09:00—09:20'), false);
  assert.equal(windowCovers('10:30—12:30', '11:30—12:10'), true);
});

test('阶段0代取在代理范围内，阶段1收窄后越界', () => {
  const x3 = stationRows.find(row => row.sheet === 'X3');
  assert.equal(evaluateConsent(x3, consentPhase0).within, true);
  const phase1 = evaluateConsent(x3, consentPhase1);
  assert.equal(phase1.within, false);
  assert.match(phase1.reason, /授权事项不含|时刻不覆盖/);
});

test('陪诊在阶段1的授权范围内', () => {
  const e4 = stationRows.find(row => row.sheet === 'E4');
  assert.equal(evaluateConsent(e4, consentPhase1).within, true);
});

test('转站分组必须取得连续服务凭证', () => {
  const groups = groupVisits(stationRows);
  const v13 = groups.find(group => group.visit === 'V-13');
  const withCredential = resolveCredential(v13, consentPhase1);
  assert.equal(withCredential.ok, true);
  assert.equal(withCredential.credential, 'PAX-9');
  const without = resolveCredential(v13, []);
  assert.equal(without.ok, false);
  assert.match(without.reason, /连续服务凭证/);
});

test('街道同日同类独立有效探访被识别为不可覆盖的冲突', () => {
  const groups = groupVisits(stationRows);
  const v12 = groups.find(group => group.visit === 'V-12');
  assert.equal(findStreetConflict(v12, streetRows), null);
  const conflictingRows = normalizeStreetRows([
    { 老人编号: 'N-3', 探访编号: 'V-99', 类别: '代取', 日期: '2026-11-19', 办理号: 'J-77' },
  ]);
  const conflict = findStreetConflict(v12, conflictingRows);
  assert.equal(conflict.receipt, 'J-77');
});

test('经办号对同一分组稳定、对撤销与回填各自独立且确定', () => {
  const groups = groupVisits(stationRows);
  const v12 = groups.find(group => group.visit === 'V-12');
  const key = registrationRequestKey(v12);
  assert.equal(key, registrationRequestKey(v12));
  assert.match(key, /^ST-REG-[0-9a-f]{8}$/);
  assert.match(revokeRequestKey(v12, 'R-12345678'), /^ST-REV-[0-9a-f]{8}$/);
  assert.match(stationConfirmRequestKey('X3', 'R-12345678'), /^HZ-CFM-[0-9a-f]{8}$/);
  assert.notEqual(revokeRequestKey(v12, 'R-12345678'), key);
});
