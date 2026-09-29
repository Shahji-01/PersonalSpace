import { expect, test } from '@playwright/test';

test('landing shell stays readable and legal links expose development status', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Less scattered. More you.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('landing.png'), fullPage: true });
  await page.getByRole('link', { name: 'Privacy draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your data deserves care.' })).toBeVisible();
  await expect(page.getByText('DEVELOPMENT DRAFT · NOT A LAUNCH NOTICE')).toBeVisible();
  await page.getByRole('link', { name: 'Terms draft', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A space under construction.' })).toBeVisible();
  expect(errors).toEqual([]);
});
