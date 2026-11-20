import { expect, openAs, signIn, test } from './fixtures';

test.describe('analytics and settings', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'desktop', 'runs at desktop width');
  });

  test('g a opens analytics: a sentence, the custody chart and the day book', async ({ page }) => {
    await signIn(page, 'anil@qamar.example');
    await expect(page).toHaveURL(/\/inbox/);
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await expect(page).toHaveURL(/\/analytics/);
    await expect(
      page.getByText(
        /^The assistant resolved \d+ of \d+ conversations \(\d+%\) without a person\.$/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Who held conversations, by day' }),
    ).toBeVisible();
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(8); // header + 7 days
    await expect(
      page.getByRole('heading', { name: 'Why conversations went to a person' }),
    ).toBeVisible();
    await page.getByLabel('Period').selectOption('30');
    await expect(page.getByRole('table').getByRole('row')).toHaveCount(31);
  });

  test('an owner changes the tone; it is saved, stamped, and put back', async ({ page }) => {
    await signIn(page, 'anil@qamar.example');
    await expect(page).toHaveURL(/\/inbox/);
    await page.goto('/settings');
    const assistant = page.getByRole('region', { name: 'Assistant' });
    await assistant.getByRole('radio', { name: /^Brief/ }).check();
    await assistant.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(assistant.getByRole('status')).toHaveText('Saved.');
    await expect(assistant.getByText(/^Changed .* · Anil Kumar$/)).toBeVisible();

    // A closing time before the opening time is refused before anything is sent.
    const hours = page.getByRole('region', { name: /^Opening hours/ });
    await hours.getByLabel('Monday closes').fill('09:00');
    await hours.getByRole('button', { name: 'Save opening hours' }).click();
    await expect(hours.getByRole('alert')).toHaveText(
      'Not saved. Monday: closing time must be after opening time.',
    );

    await page.reload();
    await expect(assistant.getByRole('radio', { name: /^Brief/ })).toBeChecked();
    await assistant.getByRole('radio', { name: /^Warm/ }).check();
    await assistant.getByRole('button', { name: 'Save assistant settings' }).click();
    await expect(assistant.getByRole('status')).toHaveText('Saved.');
  });

  test('an agent sees settings but cannot change them, and has no team section', async ({
    page,
  }) => {
    await signIn(page, 'priya@qamar.example');
    await expect(page).toHaveURL(/\/inbox/);
    await page.goto('/settings');
    await expect(
      page.getByText('Only the owner can change settings. You can see them here.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save business details' })).toHaveCount(0);
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Team' })).toHaveCount(0);
  });

  test('an owner invites someone; the link makes their account; the owner removes them', async ({
    page,
    browser,
  }) => {
    await signIn(page, 'anil@qamar.example');
    await expect(page).toHaveURL(/\/inbox/);
    await page.goto('/settings');
    const team = page.getByRole('region', { name: 'Team' });
    const email = `farah-${Date.now().toString(36)}@qamar.example`;
    await team.getByLabel('Name', { exact: true }).fill('Farah Khan');
    await team.getByLabel('Email').fill(email);
    await team.getByRole('button', { name: 'Make an invite link' }).click();
    const link = await team.getByLabel('Link').inputValue();
    expect(link).toMatch(/\/join\/[A-Za-z0-9_-]{43}$/);
    await page.screenshot({ path: 'e2e/screenshots/settings-team-desktop.png' });

    // The invited person, in their own browser.
    const theirs = await browser.newContext();
    try {
      const them = await theirs.newPage();
      await them.goto(link);
      await expect(
        them.getByText('Qamar Phone Corner invited you to its support desk.', { exact: false }),
      ).toBeVisible();
      await them.getByLabel('New password').fill('farah-long-password');
      await them.getByRole('button', { name: 'Create my account' }).click();
      await expect(them.getByRole('status')).toContainText('Your account is ready.');
      await them.getByRole('link', { name: 'Go to sign in' }).click();
      await signIn(them, email, 'farah-long-password');
      await expect(them).toHaveURL(/\/inbox/);
      // The link works once.
      await them.goto(link);
      await expect(them.getByText(/expired or was already used/)).toBeVisible();
    } finally {
      await theirs.close();
    }

    await page.reload();
    await team
      .getByRole('listitem')
      .filter({ hasText: email })
      .getByRole('button', { name: 'Remove' })
      .click();
    await page.getByRole('button', { name: 'Remove Farah Khan' }).click();
    await expect(team.getByText(email)).toHaveCount(0);
  });
});

test('screenshots: analytics and settings', async ({ browser }, info) => {
  const desk = await openAs(browser, 'anil@qamar.example');
  try {
    await desk.page.goto('/analytics');
    await expect(desk.page.getByText(/^The assistant resolved/)).toBeVisible();
    await desk.page.screenshot({
      path: `e2e/screenshots/analytics-${info.project.name}.png`,
      fullPage: true,
    });
    await desk.page.goto('/settings');
    await expect(desk.page.getByRole('button', { name: 'Save business details' })).toBeVisible();
    await desk.page.screenshot({ path: `e2e/screenshots/settings-${info.project.name}.png` });
    expect(
      await desk.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(info.project.name === 'mobile' ? 390 : 1440);
  } finally {
    await desk.close();
  }
});
