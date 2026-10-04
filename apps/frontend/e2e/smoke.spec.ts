import { expect, test, type Page } from '@playwright/test';

const name = `e2e${Date.now().toString(36).slice(-6)}`;

async function login(page: Page, who: string) {
  await page.goto('/');
  await page.getByTestId('dev-name').fill(who);
  await page.getByTestId('dev-login').click();
  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(who);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(who, { timeout: 15_000 });
}

test('dev login, claim a starter, run a daemon, move by clicking, run the starter script in the sandbox', async ({ page }) => {
  // Behind Caddy the pages carry a strict CSP; any violation (host page, Monaco, sandbox) fails the run.
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));

  if (process.env.E2E_BASE_URL) {
    // Against the production image the headers must really be there, otherwise the collector above proves nothing.
    const sandbox = await page.request.get('/sandbox.html');
    expect(sandbox.headers()['content-security-policy']).toContain("default-src 'none'");
    expect((await page.request.get('/')).headers()['content-security-policy']).toContain("script-src 'self';");
  }

  await page.goto('/');
  await page.getByTestId('dev-name').fill(name);
  await page.getByTestId('dev-login').click();

  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(name, { timeout: 15_000 });

  // the world ticks
  const tick0 = Number(await page.getByTestId('tick').textContent());
  await expect.poll(async () => Number(await page.getByTestId('tick').textContent())).toBeGreaterThan(tick0);

  // run the starter from RAM, then click the map to move; no rejection may appear in the log
  await page.getByTestId('tab-ram').click();
  await page.getByTestId('run-0').click();
  const canvas = page.getByTestId('world');
  const box = (await canvas.boundingBox())!;
  const tickAtClick = Number(await page.getByTestId('tick').textContent());
  await canvas.click({ position: { x: box.width / 2 + 96, y: box.height / 2 } });
  // a rejection arrives within a few ticks of the command; wait for the world to advance past that window
  await expect.poll(async () => Number(await page.getByTestId('tick').textContent())).toBeGreaterThanOrEqual(tickAtClick + 8);
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).not.toContainText('moveTo:');
  await expect(page.getByTestId('log')).not.toContainText('run:');

  // the sandbox runs the starter template (it logs as soon as it connects through the bridge)
  await page.getByTestId('tab-script').click();
  await expect(page.getByTestId('script-status')).toContainText('stopped', { timeout: 15_000 });
  await page.getByRole('button', { name: 'insert starter template' }).click();
  await page.getByTestId('run-script').click();
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).toContainText(`online as ${name}`, { timeout: 20_000 });
  await expect(page.getByTestId('log')).not.toContainText('E_');

  expect(violations).toEqual([]);
});

test('a level-8 daemon seeded on Disk is loaded at the host and evolved from the RAM card; the codex tree marks the discovery', async ({ page }) => {
  const who = `${name}e`;
  await page.goto('/');
  await page.getByTestId('dev-name').fill(who);
  await page.getByTestId('dev-login').click();
  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(who);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(who, { timeout: 15_000 });

  // seed through the dev route (shares the page's session cookie), then load it into RAM at the host (the spawn point is within reach)
  const seeded = await page.request.post('/api/dev/daemon', { data: { species: 'pingling', level: 8 }, headers: { 'x-requested-with': 'daemonet' } });
  expect(seeded.ok()).toBeTruthy();
  await page.getByTestId('tab-disk').click();
  await page.getByRole('button', { name: 'refresh' }).click();
  await page.getByRole('button', { name: 'load into RAM' }).click();
  await page.getByTestId('tab-ram').click();
  await expect(page.getByTestId('ram-1-name')).toHaveText('Pingling', { timeout: 15_000 });
  await expect(page.getByTestId('evolve-1')).toContainText('Echolet');
  await page.getByTestId('evolve-1-echolet').click();
  await expect(page.getByTestId('ram-1-name')).toHaveText('Echolet', { timeout: 15_000 });
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).toContainText('evolved: pingling -> echolet');

  await page.getByTestId('tab-codex').click();
  await page.getByRole('button', { name: 'refresh' }).click();
  await expect(page.getByTestId('tree-echolet')).toContainText('✓', { timeout: 10_000 });
});

test('with dev bits: buy a tap at the host, decompile a seeded daemon into fragments, craft a restore from them', async ({ page }) => {
  const who = `${name}h`;
  // log in and seed through the API before the sim loads the operator: bits granted outside the sim are read on connect
  const headers = { 'x-requested-with': 'daemonet' };
  expect((await page.request.get(`/api/auth/dev?name=${who}`, { maxRedirects: 0 })).status()).toBe(302);
  expect((await page.request.post('/api/dev/bits', { data: { amount: 512 }, headers })).ok()).toBeTruthy();
  expect((await page.request.post('/api/dev/daemon', { data: { species: 'tracerat', level: 20 }, headers })).ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveText('online', { timeout: 20_000 });
  await page.getByTestId('name-input').fill(who);
  await page.getByTestId('claim').click();
  await expect(page.getByTestId('operator-name')).toHaveText(who, { timeout: 15_000 });

  await page.getByTestId('tab-host').click();
  await expect(page.getByTestId('host-status')).toContainText('at the host');
  await page.getByTestId('host-shop').click();
  await page.getByTestId('buy-tap').click();
  await expect(page.getByTestId('host-status')).toContainText('384 bits', { timeout: 10_000 });

  await page.getByTestId('tab-disk').click();
  await page.getByRole('button', { name: 'refresh' }).click();
  await page.getByRole('button', { name: 'load into RAM' }).click();
  await page.getByTestId('tab-ram').click();
  await expect(page.getByTestId('ram-1-name')).toHaveText('Tracerat', { timeout: 15_000 });
  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('decompile-1').click();
  await expect(page.getByTestId('ram-1')).toHaveCount(0, { timeout: 15_000 });

  await page.getByTestId('tab-host').click();
  await page.getByTestId('host-craft').click();
  await page.getByTestId('using').selectOption('packet');
  await page.getByTestId('craft-restore').click();
  await expect(page.getByTestId('host-status')).toContainText('368 bits', { timeout: 10_000 });
  await page.getByTestId('tab-log').click();
  await expect(page.getByTestId('log')).toContainText('decompiled tracerat');
  await expect(page.getByTestId('log')).toContainText('-16 bits (craft)');

  // tickets: accept the first (always a tool-free clear ticket on lo), see it open, abandon it
  await page.getByTestId('tab-host').click();
  await page.getByTestId('host-tickets').click();
  await expect(page.getByTestId('board-0')).toContainText('Clear', { timeout: 10_000 });
  await page.getByTestId('accept-0').click();
  await expect(page.getByTestId('tickets')).toContainText('open (1/2) · accepted today 1/8', { timeout: 10_000 });
  await expect(page.getByTestId('board-0')).toContainText('open');
  await page.getByRole('button', { name: 'abandon' }).click();
  await expect(page.getByTestId('tickets')).toContainText('open (0/2) · accepted today 1/8', { timeout: 10_000 });
});

test('two operators chat in subnet:lo; the filter masks and blocks; a line can be reported', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await login(pa, `${name}ca`);
  await login(pb, `${name}cb`);
  await pa.getByTestId('tab-chat').click();
  await pb.getByTestId('tab-chat').click();
  await pa.getByTestId('chat-input').fill('hello from a, what the fuck');
  await pa.getByTestId('chat-send').click();
  await expect(pb.getByTestId('chat-lines')).toContainText('hello from a, what the ***', { timeout: 10_000 });
  await expect(pa.getByTestId('chat-lines')).toContainText(`${name}ca`);
  await pb.getByTestId('chat-input').fill('kys');
  await pb.getByTestId('chat-send').click();
  await pb.getByTestId('tab-log').click();
  await expect(pb.getByTestId('log')).toContainText('message blocked by the chat filter', { timeout: 10_000 });
  await pb.getByTestId('tab-chat').click();
  await pb.locator('[data-testid^="report-m"]').first().click();
  await pb.getByTestId('report-send').click();
  await pb.getByTestId('tab-log').click();
  await expect(pb.getByTestId('log')).toContainText('report received', { timeout: 10_000 });

  // clusters: A opens one, B joins by code, both see two members, then B leaves
  await pa.getByTestId('tab-chat').click();
  await pa.getByTestId('cluster-create').click();
  await expect(pa.getByTestId('cluster-code')).toHaveText(/^[A-Z2-9]{6}$/, { timeout: 10_000 });
  const code = (await pa.getByTestId('cluster-code').textContent())!.trim();
  await pb.getByTestId('tab-chat').click();
  await pb.getByTestId('cluster-code-input').fill(code);
  await pb.getByTestId('cluster-join').click();
  await expect(pa.getByTestId('cluster-members').locator('li')).toHaveCount(2, { timeout: 10_000 });
  await expect(pb.getByTestId('cluster-members')).toContainText(`${name}ca`);
  await pb.getByTestId('cluster-leave').click();
  await expect(pa.getByTestId('cluster-members').locator('li')).toHaveCount(1, { timeout: 10_000 });

  // orgs: A (granted bits while online — the balance arrives over the bus) founds one; the tag shows in the top bar and on chat lines
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, 'X');
  expect((await pa.request.post('/api/dev/bits', { data: { amount: 10000 }, headers: { 'x-requested-with': 'daemonet' } })).ok()).toBeTruthy();
  await pa.getByTestId('tab-org').click();
  await pa.getByTestId('org-name').fill(`Org ${name}`);
  await pa.getByTestId('org-tag').fill(tag);
  await expect(pa.getByTestId('org-create')).toBeEnabled({ timeout: 10_000 });
  await pa.getByTestId('org-create').click();
  await pa.getByTestId('org-confirm').click(); // paid: confirmed first
  await expect(pa.getByTestId('org-current-tag')).toHaveText(`[${tag}]`, { timeout: 10_000 });
  await expect(pa.getByTestId('operator-name')).toContainText(`[${tag}]`, { timeout: 10_000 });
  await pa.getByTestId('org-leave').click(); // the last member: disband, confirmed first
  await pa.getByTestId('org-confirm').click();
  await expect(pa.getByTestId('org-create')).toBeVisible({ timeout: 10_000 });
  await a.close();
  await b.close();
});
