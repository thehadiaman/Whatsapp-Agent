import { expect, signIn, test } from './fixtures';

// Screenshots at 1440 px and 390 px (one Playwright project each) for the
// design check in DESIGN.md. Written to e2e/screenshots/, not committed.

function shot(name: string, project: string): string {
  return `e2e/screenshots/${name}-${project}.png`;
}

test('screenshots: sign-in, error, signed-in shell', async ({ page }, info) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.screenshot({ path: shot('sign-in', info.project.name), fullPage: true });

  await signIn(page, 'priya@qamar.example', 'not-the-password');
  await expect(page.locator('form').getByRole('alert')).toBeVisible();
  await page.screenshot({ path: shot('sign-in-error', info.project.name), fullPage: true });

  await signIn(page, 'priya@qamar.example');
  await expect(page).toHaveURL(/\/inbox$/);
  await page.screenshot({ path: shot('inbox-empty', info.project.name), fullPage: true });
});
