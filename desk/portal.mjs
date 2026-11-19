// 浏览器门户客户端：只通过可见页面（导航链接、表格、表单、回执页）与门户交互。
// 不使用任何站外接口或共享录入编号，所有数据都来自页面上可见的内容。

async function parseJsonPre(page) {
  const locator = page.locator('pre').first();
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  const raw = (await locator.textContent()) ?? '';
  return JSON.parse(raw);
}

export class PortalClient {
  constructor(page, origin) {
    this.page = page;
    this.origin = origin;
  }

  async open(path) {
    await this.page.goto(this.origin + path, { waitUntil: 'domcontentloaded' });
  }

  // 读取某页面可见表格，返回「表头 -> 单元格」的对象数组。
  async readTable(path) {
    await this.open(path);
    const headings = await this.page.locator('table thead th').allInnerTexts();
    const rowCount = await this.page.locator('table tbody tr').count();
    const rows = [];
    for (let index = 0; index < rowCount; index += 1) {
      const cells = await this.page.locator('table tbody tr').nth(index).locator('td').allInnerTexts();
      const record = {};
      headings.forEach((heading, cellIndex) => {
        record[heading.trim()] = cells[cellIndex]?.trim() ?? '';
      });
      rows.push(record);
    }
    return rows;
  }

  // 在指定页面按表单可见名称填写并提交，返回回执页 <pre> 中的 JSON。
  async submitForm(path, formName, values) {
    await this.open(path);
    const form = this.page.getByRole('form', { name: formName, exact: true });
    for (const [label, value] of Object.entries(values)) {
      await form.getByLabel(label, { exact: true }).fill(String(value));
    }
    await form.getByRole('button', { name: formName, exact: true }).click();
    await this.page.waitForLoadState('domcontentloaded');
    return parseJsonPre(this.page);
  }

  // 街道确认页没有回执时，用可见的「查询受理」表单按经办号查既有记录。
  async queryReceipt(path, formName, values) {
    return this.submitForm(path, formName, values);
  }
}
