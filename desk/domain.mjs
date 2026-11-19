// 领域规则：把门户可见资料转成代办决策。
// 关键口径：
// - 个人服务编号只在站点内有效，同一次探访以「共同探访编号 + 老人 + 日期 + 实际时段」认定。
// - 代理授权按代签人、适用事项、起止时刻逐项核对；换人授权只影响其适用时段。
// - 转站单必须另有连续服务凭证，凭证只适用于授权范围之内的时段与事项。
// - 街道按老人和日期限制同类服务，同日已有独立有效探访只能避让，不能覆盖。

import { createHash } from 'node:crypto';

const SHEET_HEADERS = {
  station: '站点',
  sheet: '服务单',
  resident: '老人编号',
  visit: '共同探访',
  signer: '代签人',
  item: '分项',
  date: '日期',
  period: '时段',
  status: '状态',
};

const CONSENT_HEADERS = {
  resident: '老人编号',
  signer: '代签人',
  scope: '适用事项',
  window: '起止时刻',
  credential: '连续服务凭证',
};

const STREET_HEADERS = {
  resident: '老人编号',
  visit: '探访编号',
  category: '类别',
  date: '日期',
  receipt: '办理号',
};

function splitItems(value) {
  return value.split(/[、,，]/).map(part => part.trim()).filter(Boolean);
}

// "09:00—09:20" -> [分钟起, 分钟止]，兼容两种破折号。
function timeRange(value) {
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*[—–-]\s*(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const toMinutes = (hour, minute) => Number(hour) * 60 + Number(minute);
  return [toMinutes(match[1], match[2]), toMinutes(match[3], match[4])];
}

// 授权时刻窗必须完整覆盖实际时段。
export function windowCovers(consentWindow, actualPeriod) {
  const outer = timeRange(consentWindow);
  const inner = timeRange(actualPeriod);
  if (!outer || !inner) return false;
  return outer[0] <= inner[0] && outer[1] >= inner[1];
}

export function normalizeStationRows(rows) {
  return rows.map(row => ({
    station: row[SHEET_HEADERS.station],
    sheet: row[SHEET_HEADERS.sheet],
    resident: row[SHEET_HEADERS.resident],
    visit: row[SHEET_HEADERS.visit],
    signer: row[SHEET_HEADERS.signer],
    item: row[SHEET_HEADERS.item],
    date: row[SHEET_HEADERS.date],
    period: row[SHEET_HEADERS.period],
    status: row[SHEET_HEADERS.status],
  }));
}

export function normalizeConsentRows(rows) {
  return rows.map(row => ({
    resident: row[CONSENT_HEADERS.resident],
    signer: row[CONSENT_HEADERS.signer],
    items: splitItems(row[CONSENT_HEADERS.scope]),
    window: row[CONSENT_HEADERS.window],
    credential: row[CONSENT_HEADERS.credential],
  }));
}

export function normalizeStreetRows(rows) {
  return rows.map(row => ({
    resident: row[STREET_HEADERS.resident],
    visit: row[STREET_HEADERS.visit],
    category: row[STREET_HEADERS.category],
    date: row[STREET_HEADERS.date],
    receipt: row[STREET_HEADERS.receipt],
  }));
}

// 同一次探访的多份服务单（含双人记录）合并为一个登记组。
// 转站单的认定：老人在本批资料中出现的多个站点里，服务单数最多（并列取最先出现）
// 的站点为归属站点；其余站点出具的服务单属于转站单，需要连续服务凭证。
export function groupVisits(sheets) {
  const homeStationByResident = new Map();
  const stationCountsByResident = new Map();
  for (const sheet of sheets) {
    if (!stationCountsByResident.has(sheet.resident)) {
      stationCountsByResident.set(sheet.resident, new Map());
      homeStationByResident.set(sheet.resident, sheet.station);
    }
    const counts = stationCountsByResident.get(sheet.resident);
    counts.set(sheet.station, (counts.get(sheet.station) ?? 0) + 1);
  }
  for (const [resident, counts] of stationCountsByResident) {
    let home = homeStationByResident.get(resident);
    for (const [station, count] of counts) {
      if (count > counts.get(home)) home = station;
    }
    homeStationByResident.set(resident, home);
  }

  const groups = new Map();
  for (const sheet of sheets) {
    const key = [sheet.resident, sheet.visit, sheet.date, sheet.period].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        resident: sheet.resident,
        visit: sheet.visit,
        date: sheet.date,
        period: sheet.period,
        stations: new Set(),
        items: new Set(),
        signers: new Set(),
        sheets: [],
      });
    }
    const group = groups.get(key);
    group.stations.add(sheet.station);
    group.items.add(sheet.item);
    group.signers.add(sheet.signer);
    group.sheets.push(sheet);
  }
  return [...groups.values()].map(group => {
    const stations = [...group.stations];
    return {
      ...group,
      stations,
      items: [...group.items],
      signers: [...group.signers],
      crossStation: stations.some(station => station !== homeStationByResident.get(group.resident)),
    };
  });
}

// 核对某条服务单当前是否在代理同意范围内，返回依据。
export function evaluateConsent(sheet, consents) {
  const matching = consents.filter(entry =>
    entry.resident === sheet.resident && entry.signer === sheet.signer);
  if (matching.length === 0) {
    return { within: false, reason: '找不到该代签人的代理授权', evidence: [] };
  }
  const covering = matching.filter(entry =>
    entry.items.includes(sheet.item) && windowCovers(entry.window, sheet.period));
  if (covering.length === 0) {
    const itemMatched = matching.some(entry => entry.items.includes(sheet.item));
    return {
      within: false,
      reason: itemMatched
        ? `代签人 ${sheet.signer} 对「${sheet.item}」的授权时刻不覆盖实际时段 ${sheet.period}`
        : `代签人 ${sheet.signer} 的授权事项不含「${sheet.item}」`,
      evidence: matching,
    };
  }
  return { within: true, reason: '代理授权覆盖该事项与实际时段', evidence: covering };
}

// 转站单需要连续服务凭证；凭证取自覆盖该时段的授权记录。
export function resolveCredential(group, consents) {
  if (!group.crossStation) return { ok: true, credential: null, reason: '本站服务单，无需连续服务凭证' };
  const credentials = new Set();
  for (const sheet of group.sheets) {
    const covering = consents.filter(entry =>
      entry.resident === sheet.resident &&
      entry.signer === sheet.signer &&
      entry.items.includes(sheet.item) &&
      windowCovers(entry.window, sheet.period) &&
      entry.credential);
    if (covering.length === 0) {
      return { ok: false, credential: null, reason: `转站服务单 ${sheet.sheet} 缺少覆盖该时段的连续服务凭证` };
    }
    covering.forEach(entry => credentials.add(entry.credential));
  }
  if (credentials.size > 1) {
    return { ok: false, credential: null, reason: `探访 ${group.visit} 出现多个不一致的连续服务凭证：${[...credentials].join('、')}` };
  }
  return { ok: true, credential: [...credentials][0], reason: '连续服务凭证可核实' };
}

// 街道同日同类已有独立有效探访（办理号可核实）时，本组只能避让。
export function findStreetConflict(group, streetRows) {
  return streetRows.find(record =>
    record.resident === group.resident &&
    record.date === group.date &&
    group.items.includes(record.category) &&
    record.receipt &&
    record.visit !== group.visit) ?? null;
}

export function registrationRequestKey(group) {
  const digest = createHash('sha1').update(group.key).digest('hex').slice(0, 8);
  return `ST-REG-${digest}`;
}

export function revokeRequestKey(group, priorReceipt) {
  const digest = createHash('sha1').update(group.key + '|' + priorReceipt).digest('hex').slice(0, 8);
  return `ST-REV-${digest}`;
}

export function stationConfirmRequestKey(sheetId, receipt) {
  const digest = createHash('sha1').update(sheetId + '|' + receipt).digest('hex').slice(0, 8);
  return `HZ-CFM-${digest}`;
}

// 街道门户「日期与实际时段」字段值。
export function formatPeriod(group) {
  return `${group.date} ${group.period}`;
}

export function buildRegisterSummary(group, credential, consentNote) {
  const parts = [
    `共同探访编号 ${group.visit}`,
    `合并服务单 ${group.sheets.map(sheet => sheet.sheet).join('、')}`,
    `分项 ${group.items.join('、')}`,
    `代签人 ${group.signers.join('、')}`,
  ];
  if (credential) parts.push(`连续服务凭证 ${credential}`);
  parts.push(consentNote);
  return parts.join('；');
}

// 撤销原因必须能让街道核对原登记越界点。
export function buildRevokeReason(group, consentResult) {
  return `探访 ${group.visit}（${group.date} ${group.period}）登记后代理范围变更：${consentResult.reason}`;
}
