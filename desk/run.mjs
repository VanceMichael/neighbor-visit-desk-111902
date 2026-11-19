// 代办编排：每次运行都从门户可见页面重新取证，再按台账决定下一步动作。
// 原则：
// 1. 只通过浏览器可见页面填报，不写任何门户没有暴露的接口。
// 2. 街道按老人/日期/类别限制，同日已有独立有效探访只避让不覆盖。
// 3. 确认页没有回执就先查既有记录；仍无法证明成功或失败时，分项停在人工接手位。
// 4. 撤销原因和原办理号留给街道；街道撤销确立前，互助站不标撤销。
// 5. 一个分组被卡住不影响同一服务单/其他分组可确定的分项继续办理。

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PortalClient } from './portal.mjs';
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
  formatPeriod,
  buildRegisterSummary,
  buildRevokeReason,
} from './domain.mjs';
import {
  loadLedger,
  saveLedger,
  groupEntry,
  appendHistory,
  setHandoff,
  clearHandoff,
  renderReport,
} from './ledger.mjs';

const STATION_PAGE = '/station';
const CONSENT_PAGE = '/consent';
const STREET_PAGE = '/street';
const REGISTER_FORM = '提交探访登记';
const REVOKE_FORM = '申请撤销';
const FIND_FORM = '查询受理';
const STATION_CONFIRM_FORM = '登记街道办理号';

export async function runDesk(options) {
  const { origin, ledgerFile, reportFile, request } = options;
  const ledger = await loadLedger(ledgerFile);
  const runRecord = { startedAt: new Date().toISOString(), origin, actions: [] };

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const portal = new PortalClient(page, origin);

    const stationRows = normalizeStationRows(await portal.readTable(STATION_PAGE));
    const consentRows = normalizeConsentRows(await portal.readTable(CONSENT_PAGE));
    const streetRows = normalizeStreetRows(await portal.readTable(STREET_PAGE));

    let sheets = stationRows;
    if (request?.serviceSheets?.length) {
      sheets = sheets.filter(sheet => request.serviceSheets.includes(sheet.sheet));
    }
    const groups = groupVisits(sheets);

    for (const group of groups) {
      const entry = groupEntry(ledger, group.key);
      entry.visit = group.visit;
      entry.resident = group.resident;
      entry.date = group.date;
      entry.period = group.period;
      entry.items = group.items;
      entry.sheets = group.sheets.map(sheet => ({
        sheet: sheet.sheet, station: sheet.station, status: sheet.status, signer: sheet.signer, item: sheet.item,
      }));

      const evidence = [
        `互助站服务单：${group.sheets.map(sheet => `${sheet.sheet}（${sheet.station}，状态「${sheet.status}」）`).join('、')}`,
        `共同探访编号 ${group.visit}，${group.date} ${group.period}，代签人 ${group.signers.join('、')}`,
        `街道既有记录：${streetRows.length ? streetRows.map(record => `${record.visit}/${record.category}/${record.receipt}`).join('、') : '无'}`,
      ];

      // 街道撤销已经确立的分组不再重复登记。
      if (entry.revoke?.state === '已受理') {
        appendHistory(entry, { action: '跳过', detail: '街道撤销已确立，等待人工在互助站标注撤销' });
        continue;
      }

      // 1) 代理授权核对优先：状态为「代理范围待更正」的服务单意味着授权已经变化，
      //    若街道侧已有登记，必须先走撤销而不是再登记一次。换人/收窄只影响适用时段。
      const consentResults = group.sheets.map(sheet => ({ sheet, result: evaluateConsent(sheet, consentRows) }));
      const outside = consentResults.filter(candidate => !candidate.result.within);
      if (outside.length) {
        const note = outside.map(candidate => `${candidate.sheet.sheet}：${candidate.result.reason}`).join('；');
        // 台账里可能缓存着此前「待显示」的登记，先按经办号重新核实街道结果。
        if (entry.register) {
          const refreshed = await refreshRegistration(portal, entry);
          runRecord.actions.push(`${group.key}: 授权复核前重新查询街道 -> ${refreshed.state}`);
        }
        // 已在街道登记成功、现在发现越过代理范围：走撤销，而不是再登记一次。
        if (entry.register?.state === '已受理' && entry.register.receipt) {
          await handleRevoke(portal, entry, group, note, evidence, runRecord);
          continue;
        }
        setHandoff(entry, `代理范围核对未通过：${note}`, evidence, [
          entry.register ? '凭经办号 ' + entry.register.requestKey + ' 向街道核实登记结果后决定撤销或补正'
            : '由经办人核对代理授权后再提交街道登记',
        ]);
        appendHistory(entry, { action: '人工接手', detail: note });
        runRecord.actions.push(`${group.key}: 授权越界停办`);
        continue;
      }

      // 2) 授权没有问题，但服务单本身仍待签署：街道门户只收已确认完成的时段。
      //    「代理范围待更正」已在上一步按授权分支处理，这里只拦截真正的待办单。
      const unconfirmed = group.sheets.filter(sheet => sheet.status === '待签署');
      if (unconfirmed.length) {
        setHandoff(entry,
          `服务单 ${unconfirmed.map(sheet => sheet.sheet).join('、')} 尚未确认完成，街道门户不接受待办时段`,
          evidence,
          unconfirmed.map(sheet => `补齐 ${sheet.sheet}（${sheet.item}）的签署证明后重新运行代办`));
        appendHistory(entry, { action: '人工接手', detail: entry.handoff.reason });
        runRecord.actions.push(`${group.key}: 待签署停办`);
        continue;
      }

      // 3) 转站单必须有连续服务凭证。
      const credentialCheck = resolveCredential(group, consentRows);
      if (!credentialCheck.ok) {
        setHandoff(entry, credentialCheck.reason, evidence, ['补齐转站连续服务凭证后重新运行代办']);
        appendHistory(entry, { action: '人工接手', detail: credentialCheck.reason });
        runRecord.actions.push(`${group.key}: 凭证缺失停办`);
        continue;
      }

      // 4) 街道同日同类已有独立有效探访：不能覆盖，避让并留痕。
      //    既看街道页面上的既有记录，也看本台账此前已经受理的其他探访分组。
      const conflict = findStreetConflict(group, streetRows);
      const ownConflict = Object.values(ledger.groups).find(other =>
        other.key !== group.key &&
        other.resident === group.resident &&
        other.date === group.date &&
        other.visit !== group.visit &&
        other.register?.state === '已受理' &&
        other.items.some(item => group.items.includes(item)));
      if (conflict || ownConflict) {
        const detail = conflict
          ? `街道页面已有独立有效探访 ${conflict.visit}（${conflict.category}，办理号 ${conflict.receipt}）`
          : `本台账已有同日同类受理探访 ${ownConflict.visit}（办理号 ${ownConflict.register.receipt}）`;
        setHandoff(entry,
          `${detail}，按老人与日期的同类服务限制不可覆盖`,
          evidence,
          [`由经办人核实两条记录是否为不同服务，再决定是否另行申报`]);
        appendHistory(entry, { action: '人工接手', detail: '同日同类有效探访冲突，避让' });
        runRecord.actions.push(`${group.key}: 街道冲突避让`);
        continue;
      }

      clearHandoff(entry);
      await handleRegistration(portal, entry, group, credentialCheck.credential, consentRows, evidence, runRecord);
    }

    ledger.runs.push(runRecord);
    await saveLedger(ledgerFile, ledger);
    const report = renderReport(ledger);
    await mkdir(dirname(reportFile), { recursive: true });
    await writeFile(reportFile, report);

    return {
      ledger,
      report,
      handoffCount: Object.values(ledger.groups).filter(item => item.handoff?.open).length,
    };
  } finally {
    await browser.close();
  }
}

async function handleRegistration(portal, entry, group, credential, consentRows, evidence, runRecord) {
  const requestKey = registrationRequestKey(group);
  const consentNote = consentRows
    .filter(row => row.resident === group.resident && group.signers.includes(row.signer))
    .map(row => `授权 ${row.signer}「${row.items.join('、')}」${row.window}`)
    .join('；');
  const payload = {
    经办号: requestKey,
    老人编号: group.resident,
    探访编号: group.visit,
    类别: group.items.join('、'),
    日期与实际时段: formatPeriod(group),
    提交摘要: buildRegisterSummary(group, credential, consentNote),
  };

  let register = entry.register;
  if (!register) {
    const response = await portal.submitForm(STREET_PAGE, REGISTER_FORM, payload);
    register = toRegisterState(response, requestKey, payload);
    entry.register = register;
    appendHistory(entry, { action: '街道登记提交', detail: `经办号 ${requestKey}，页面状态「${register.state}」` });
    runRecord.actions.push(`${group.key}: 街道登记提交 -> ${register.state}`);
  }

  // 确认页没有回执：先按经办号查既有记录。
  if (register.state !== '已受理') {
    const queriedState = await refreshRegistration(portal, entry);
    if (queriedState.state !== '已受理') {
      const pageError = queriedState.raw?.error ? `，页面报错「${queriedState.raw.error}」` : '';
      setHandoff(entry,
        `街道登记暂无法证明成功或失败：确认页与查询均为「${queriedState.state}」${pageError}`,
        [...evidence, `街道经办号 ${requestKey}`, `提交内容：${JSON.stringify(payload)}`],
        [`凭经办号 ${requestKey} 在街道门户继续查询，拿到办理号后回填互助站`]);
      runRecord.actions.push(`${group.key}: 登记结果不可核实，人工接手`);
      return;
    }
  }

  // 办理号可核实后，逐单回填互助站（每份服务单独立经办号，幂等）。
  for (const sheet of group.sheets) {
    await handleStationConfirm(portal, entry, sheet, entry.register, runRecord);
  }
}

// 按经办号在街道可见页面重新查询，用最新页面结果刷新台账缓存。
async function refreshRegistration(portal, entry) {
  const requestKey = entry.register.requestKey;
  const queried = await portal.queryReceipt(STREET_PAGE, FIND_FORM, { 经办号: requestKey });
  const queriedState = toRegisterState(queried, requestKey, entry.register.payload);
  appendHistory(entry, { action: '街道受理查询', detail: `页面状态「${queriedState.state}」` });
  if (queriedState.state === '已受理') entry.register = queriedState;
  return queriedState;
}

async function handleStationConfirm(portal, entry, sheet, register, runRecord) {
  const existing = entry.stationConfirms[sheet.sheet];
  if (existing?.state === '已受理') return;
  const requestKey = existing?.requestKey ?? stationConfirmRequestKey(sheet.sheet, register.receipt);
  const payload = {
    服务单: sheet.sheet,
    互助站经办号: requestKey,
    街道办理号: register.receipt,
  };
  const response = await portal.submitForm(STATION_PAGE, STATION_CONFIRM_FORM, payload);
  const state = response.state ?? (response.error ? '失败' : '未知');
  entry.stationConfirms[sheet.sheet] = {
    stationSheet: sheet.sheet,
    requestKey,
    receipt: register.receipt,
    state,
    raw: response,
  };
  appendHistory(entry, {
    action: '互助站回填办理号',
    detail: `服务单 ${sheet.sheet}，街道办理号 ${register.receipt}，状态「${state}」`,
  });
  runRecord.actions.push(`${sheet.sheet}: 互助站回填 -> ${state}`);
}

async function handleRevoke(portal, entry, group, reasonText, evidence, runRecord) {
  const priorReceipt = entry.register.receipt;
  const requestKey = revokeRequestKey(group, priorReceipt);
  let revoke = entry.revoke;
  if (!revoke) {
    const payload = {
      经办号: requestKey,
      原办理号: priorReceipt,
      撤销原因: buildRevokeReason(group, { reason: reasonText }),
    };
    const response = await portal.submitForm(STREET_PAGE, REVOKE_FORM, payload);
    revoke = {
      requestKey,
      priorReceipt,
      reason: payload.撤销原因,
      state: response.state ?? (response.error ? '失败' : '未知'),
      receipt: response.receipt ?? null,
      raw: response,
    };
    entry.revoke = revoke;
    appendHistory(entry, { action: '街道撤销提交', detail: `原办理号 ${priorReceipt}，状态「${revoke.state}」` });
    runRecord.actions.push(`${group.key}: 街道撤销提交 -> ${revoke.state}`);
  }

  if (revoke.state !== '已受理') {
    const queried = await portal.queryReceipt(STREET_PAGE, FIND_FORM, { 经办号: requestKey });
    appendHistory(entry, { action: '撤销受理查询', detail: `页面状态「${queried.state ?? '未知'}」` });
    if (queried.state === '已受理') {
      revoke.state = queried.state;
      revoke.receipt = queried.receipt ?? revoke.receipt;
    } else {
      setHandoff(entry,
        `街道撤销结果暂不可核实（原办理号 ${priorReceipt}）`,
        [...evidence, `撤销经办号 ${requestKey}`, `撤销原因：${revoke.reason}`],
        [`凭经办号 ${requestKey} 查询街道撤销是否确立；确立前不得在互助站标注撤销`]);
      runRecord.actions.push(`${group.key}: 撤销结果不可核实，人工接手`);
      return;
    }
  }

  // 街道撤销确立：互助站侧只在台账标注，留给经办人按站点流程收口。
  entry.stationRevokeMarked = true;
  setHandoff(entry,
    `街道撤销已确立（原办理号 ${priorReceipt}，撤销办理号 ${revoke.receipt}），需在互助站标注服务单撤销`,
    evidence,
    group.sheets.map(sheet => `在互助站将服务单 ${sheet.sheet} 标为撤销，依据街道办理号 ${priorReceipt}`));
  appendHistory(entry, { action: '街道撤销确立', detail: `原办理号 ${priorReceipt}` });
  runRecord.actions.push(`${group.key}: 撤销确立，转人工标注互助站`);
}

function toRegisterState(response, requestKey, payload) {
  if (response.error) {
    return { requestKey, state: '失败', receipt: null, raw: response, payload };
  }
  return {
    requestKey,
    state: response.state ?? '未知',
    receipt: response.receipt ?? null,
    raw: response,
    payload,
  };
}
