import { expect, test } from '@playwright/test';

const name = `e2e${Date.now().toString(36).slice(-6)}`;

test('dev login, claim a starter, run a daemon, move by clicking, run the starter script in the sandbox', async ({ page }) => {
  // Behind Caddy the pages carry a strict CSP; any violation (host page, Monaco, sandbox) fails the run.
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) violations.push(m.text());
  });
  page.on('pageerror', (e) => violations.push(`pageerror: ${e.message}`));

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
  await canvas.click({ position: { x: box.width / 2 + 96, y: box.height / 2 } });
  await page.waitForTimeout(500);
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
