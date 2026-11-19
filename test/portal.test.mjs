import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createSource } from '../source.mjs';

const { pages, browser: contract } = JSON.parse(
  await readFile(new URL('../scenario.json', import.meta.url), 'utf8'),
);

test('浏览器能读取门户可见记录并查到表单受理状态', { timeout: 20000 }, async () => {
  const server = createSource().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    for (const portal of pages) {
      await page.getByRole('link', { name: portal.name, exact: true }).click();
      assert.equal(await page.getByRole('heading', { name: portal.name, exact: true }).count(), 1);
      assert.equal(await page.locator('tbody tr').count(), portal.rows[0].length);
    }
    await page.goto(origin + contract.page);
    assert.equal(await page.getByRole('heading', { name: contract.heading }).count(), 1);
    const form = page.getByRole('form', { name: contract.form });
    for (const [label, value] of Object.entries(contract.values)) {
      await form.getByLabel(label, { exact: true }).fill(value);
    }
    await form.getByRole('button', { name: contract.form }).click();
    assert.equal(await page.getByRole('heading', { name: contract.result }).count(), 1);
    await page.goto(origin + contract.page);
    const query = page.getByRole('form', { name: contract.queryForm });
    for (const [label, value] of Object.entries(contract.query)) {
      await query.getByLabel(label, { exact: true }).fill(value);
    }
    await query.getByRole('button', { name: contract.queryForm }).click();
    assert.equal(await page.getByRole('heading', { name: contract.result }).count(), 1);
    const changed = await page.request.post(origin + '/replay/phase', { data: { phase: 1 } });
    assert.ok(changed.ok());
    await page.goto(origin + contract.changedPage);
    assert.equal(await page.getByText(contract.changedText, { exact: true }).count(), 1);
  } finally {
    await browser.close();
    server.close();
    await once(server, 'close');
  }
});
