import { expect, signIn, test } from './fixtures';

test.describe('signing in', () => {
  test('an agent signs in, sees their own business, and signs out', async ({ page }) => {
    await signIn(page, 'priya@qamar.example');

    await expect(page).toHaveURL(/\/inbox$/);
    const header = page.getByRole('banner');
    await expect(header).toContainText('Qamar Phone Corner');
    await expect(header).toContainText('agent');
    await expect(page.getByRole('heading', { name: 'No conversations yet' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.goto('/inbox');
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('a wrong password shows what went wrong and what to do', async ({ page }) => {
    await signIn(page, 'priya@qamar.example', 'not-the-password');
    await expect(page.locator('form').getByRole('alert')).toHaveText(
      'Email or password is wrong. Check both and try again.',
    );
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("another business's staff see their business, not Qamar's", async ({ page }) => {
    await signIn(page, 'mariam@kayal.example');
    const header = page.getByRole('banner');
    await expect(header).toContainText('Kayal Bakes');
    await expect(header).not.toContainText('Qamar');
    await expect(header).toContainText('owner');
  });

  test('a demo account can be filled in from the list', async ({ page }) => {
    await page.goto('/sign-in');
    await page
      .getByRole('button', { name: "Fill in Nikhil Varghese's email and password" })
      .click();
    await expect(page.getByLabel('Email', { exact: true })).toHaveValue('nikhil@kayal.example');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  });

  test('the platform admin sees the list of businesses, not their data', async ({ page }) => {
    await signIn(page, 'admin@desk.example');
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('cell', { name: 'Qamar Phone Corner' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Kayal Bakes' })).toBeVisible();
  });
});
