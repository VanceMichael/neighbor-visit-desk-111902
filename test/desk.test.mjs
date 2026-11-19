import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createSource } from '../source.mjs';
import { runDesk } from '../desk/run.mjs';

async function startServer() {
  const server = createSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { server, origin };
}

async function setPhase(origin, phase) {
  const response = await fetch(origin + '/replay/phase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  assert.equal(response.status, 200);
}

// 直接在浏览器里查街道页面：街道表格是静态既有资料，新受理记录通过「查询受理」可见。
async function readStreetInBrowser(origin) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/street');
    return await page.locator('table tbody tr').evaluateAll(
      rows => rows.map(row => row.innerText),
    );
  } finally {
    await browser.close();
  }
}

async function queryInBrowser(origin, requestKey) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/street');
    const form = page.getByRole('form', { name: '查询受理', exact: true });
    await form.getByLabel('经办号', { exact: true }).fill(requestKey);
    await form.getByRole('button', { name: '查询受理', exact: true }).click();
    await page.locator('pre').first().waitFor({ state: 'visible' });
    return JSON.parse(await page.locator('pre').first().textContent());
  } finally {
    await browser.close();
  }
}

test('端到端：合并登记、待显示挂账、授权收窄撤销、转站补录与回填', { timeout: 90000 }, async () => {
  const { server, origin } = await startServer();
  const stateDir = await mkdtemp(join(tmpdir(), 'desk-e2e-'));
  const ledgerFile = join(stateDir, 'ledger.json');
  const reportFile = join(stateDir, 'report.md');
  try {
    // ---- 阶段 0 ----
    const phase0 = await runDesk({ origin, ledgerFile, reportFile, request: null });
    const v12Key = Object.keys(phase0.ledger.groups).find(key => key.includes('V-12'));
    const v13Key = Object.keys(phase0.ledger.groups).find(key => key.includes('V-13'));
    const v12Phase0 = phase0.ledger.groups[v12Key];
    const v13Phase0 = phase0.ledger.groups[v13Key];

    // 双人两份服务单只产生一次街道登记。
    assert.equal(v12Phase0.register.state, '待显示');
    assert.equal(v12Phase0.register.receipt, null);
    assert.equal(v12Phase0.handoff.open, true);
    assert.match(v12Phase0.handoff.reason, /无法证明成功或失败/);
    // 办理号不可核实前不得回填互助站。
    assert.deepEqual(Object.keys(v12Phase0.stationConfirms), []);

    // 待签署的转站单停在人工接手位，不进街道门户。
    assert.equal(v13Phase0.register, null);
    assert.equal(v13Phase0.handoff.open, true);
    assert.match(v13Phase0.handoff.reason, /尚未确认完成/);

    // 街道既有独立探访 V-10 不受影响。
    const streetAfterPhase0 = await readStreetInBrowser(origin);
    assert.ok(streetAfterPhase0.some(line => line.includes('V-10') && line.includes('J-08')));

    // ---- 切到阶段 1：回执释放、授权收窄、E4 已确认 ----
    await setPhase(origin, 1);
    const phase1 = await runDesk({ origin, ledgerFile, reportFile, request: null });
    const v12Phase1 = phase1.ledger.groups[v12Key];
    const v13Phase1 = phase1.ledger.groups[v13Key];

    // 先查到此前登记的办理号，再因授权收窄发起撤销。
    assert.equal(v12Phase1.register.state, '已受理');
    assert.match(v12Phase1.register.receipt, /^R-/);
    assert.equal(v12Phase1.revoke.state, '已受理');
    assert.equal(v12Phase1.revoke.priorReceipt, v12Phase1.register.receipt);
    assert.match(v12Phase1.revoke.reason, /代理范围变更/);
    // 街道撤销确立前互助站不回填、不标撤销；撤销确立后转人工在互助站收口。
    assert.deepEqual(Object.keys(v12Phase1.stationConfirms), []);
    assert.equal(v12Phase1.stationRevokeMarked, true);
    assert.equal(v12Phase1.handoff.open, true);
    assert.match(v12Phase1.handoff.reason, /街道撤销已确立/);

    // 转站陪诊凭连续服务凭证登记，并把可核实办理号回填互助站。
    assert.equal(v13Phase1.register.state, '已受理');
    assert.match(v13Phase1.register.payload.提交摘要, /连续服务凭证 PAX-9/);
    assert.deepEqual(Object.keys(v13Phase1.stationConfirms), ['E4']);
    assert.equal(v13Phase1.stationConfirms.E4.state, '已受理');
    assert.equal(v13Phase1.stationConfirms.E4.receipt, v13Phase1.register.receipt);

    // 街道页面上 V-10 静态记录仍在；新登记通过可见的「查询受理」各只受理一次。
    const streetFinal = await readStreetInBrowser(origin);
    assert.ok(streetFinal.some(line => line.includes('V-10') && line.includes('J-08')));
    const registerView = await queryInBrowser(origin, v13Phase1.register.requestKey);
    assert.equal(registerView.state, '已受理');
    assert.equal(registerView.submitted.visit, 'V-13');
    const revokeView = await queryInBrowser(origin, v12Phase1.revoke.requestKey);
    assert.equal(revokeView.state, '已受理');
    assert.equal(revokeView.submitted.priorReceipt, v12Phase1.register.receipt);

    // 报告包含人工接手与时间线。
    const report = await readFile(reportFile, 'utf8');
    assert.match(report, /人工接手/);
    assert.match(report, /街道撤销已确立/);
    assert.match(report, /动作时间线/);

    // ---- 幂等：再跑一次不应产生重复登记或重复撤销 ----
    const beforeRuns = phase1.ledger.runs.length;
    const rerun = await runDesk({ origin, ledgerFile, reportFile, request: null });
    assert.equal(rerun.ledger.runs.length, beforeRuns + 1);
    const v12Rerun = rerun.ledger.groups[v12Key];
    const v13Rerun = rerun.ledger.groups[v13Key];
    assert.equal(v12Rerun.register.requestKey, v12Phase1.register.requestKey);
    assert.equal(v12Rerun.register.receipt, v12Phase1.register.receipt);
    assert.equal(v12Rerun.revoke.requestKey, v12Phase1.revoke.requestKey);
    assert.equal(v12Rerun.revoke.receipt, v12Phase1.revoke.receipt);
    assert.equal(v13Rerun.register.requestKey, v13Phase1.register.requestKey);
    assert.equal(v13Rerun.register.receipt, v13Phase1.register.receipt);
    // 同经办号在街道仍只对应同一条受理。
    const registerAgain = await queryInBrowser(origin, v13Phase1.register.requestKey);
    assert.equal(registerAgain.receipt, v13Phase1.register.receipt);
    const revokeAgain = await queryInBrowser(origin, v12Phase1.revoke.requestKey);
    assert.equal(revokeAgain.receipt, v12Phase1.revoke.receipt);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    server.close();
    await once(server, 'close');
  }
});
