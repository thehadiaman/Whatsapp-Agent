import { DEMO_DEFAULT_PASSWORD } from '@app/shared';
import { test as base, expect, type Browser, type Page } from '@playwright/test';

// Each browser context acts as a different client IP, so sign-in rate-limit
// buckets (5 per minute per IP) never collide between tests. In production the
// reverse proxy sets this header; clients cannot.
function clientIp(): string {
  const n = () => Math.floor(Math.random() * 250) + 1;
  return `10.${String(n())}.${String(n())}.${String(n())}`;
}

export const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({ 'x-real-ip': clientIp() });
    await use(context);
  },
});

export { expect };

export const PASSWORD = process.env['SEED_PASSWORD'] ?? DEMO_DEFAULT_PASSWORD;

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A second person at another desk: their own context, cookies and IP. */
export async function openAs(
  browser: Browser,
  email: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const { baseURL, viewport } = test.info().project.use;
  const context = await browser.newContext({
    ...(baseURL ? { baseURL } : {}),
    ...(viewport ? { viewport } : {}),
    extraHTTPHeaders: { 'x-real-ip': clientIp() },
  });
  const page = await context.newPage();
  await signIn(page, email);
  await expect(page).toHaveURL(/\/inbox/);
  return { page, close: () => context.close() };
}
