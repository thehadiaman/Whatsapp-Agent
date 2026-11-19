import { expect, openAs, signIn, test } from './fixtures';

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
  await page.screenshot({ path: shot('inbox', info.project.name), fullPage: true });
});

test('screenshots: thread, long message, window closed', async ({ browser }, info) => {
  // One desk per person: each signs in in their own browser context.
  const capture = async (email: string, name: string, file: string) => {
    const desk = await openAs(browser, email);
    try {
      await desk.page
        .getByLabel('Conversations', { exact: true })
        .getByRole('button', { name: new RegExp(`^\\d+ ${name},`) })
        .click();
      await expect(desk.page.getByRole('heading', { name })).toBeVisible();
      await desk.page.screenshot({ path: shot(file, info.project.name) });
    } finally {
      await desk.close();
    }
  };
  await capture('priya@qamar.example', 'Fatima Al Mansoori', 'thread'); // Arabic, mine, a note
  await capture('mariam@kayal.example', 'Lakshmi Menon', 'thread-long'); // 2,019 characters, waiting
  await capture('nikhil@kayal.example', 'Joseph Mathew', 'thread-window-closed'); // Malayalam
});
