import { test, expect, type Page } from '@playwright/test';

test('previews images privately, preserves ID-only drafts and clears removed images', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Insert file', exact: true }).click();
  await page
    .getByRole('region', { name: 'Choose a file' })
    .getByRole('button', { name: /Garden inspiration/ })
    .click();
  const file = page.locator('.tiptap [data-attachment-reference]');
  await page.evaluate(() => localStorage.setItem('failDraft', 'true'));
  await file.click();
  await expect(page.getByRole('alert')).toContainText('Your changes are still here');
  expect(await page.evaluate(() => localStorage.getItem('previewedFile'))).toBeNull();
  await page.evaluate(() => {
    localStorage.removeItem('failDraft');
    localStorage.setItem('unsafePreview', 'true');
  });
  await file.click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.evaluate(() => localStorage.removeItem('unsafePreview'));
  await file.click();
  const dialog = page.getByRole('dialog', { name: 'Image preview' });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => dialog.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(240);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('image-preview-mobile.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Save or share' }).click();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('openedFile'))).toBe(
    '0199a1b0-0000-7000-8000-000000000013',
  );
  await expect(file.locator('img')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const saved = await page.evaluate(() => localStorage.getItem('saved'));
  expect(saved).toContain('0199a1b0-0000-7000-8000-000000000013');
  expect(saved).not.toContain('data:image');
  await file.click();
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('removeFile')));
  await expect(dialog).not.toBeVisible();
  await expect(file.locator('img')).toBeHidden();
  await expect(file).toContainText('Unavailable file');
});

test('inserts ID-only files, preserves drafts before opening and keeps unavailable labels', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Trip documents ');
  await editor.press('End');
  await page.getByRole('button', { name: 'Insert file', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Choose a file' });
  await expect(picker).toBeVisible();
  await picker.getByRole('textbox', { name: 'Files attached to this note' }).fill('यात्रा');
  await picker.getByRole('button', { name: /Journey notes/ }).click();
  const file = page.locator('.tiptap [data-attachment-reference]');
  await expect(file).toContainText('Journey notes — यात्रा.pdf');
  await expect(file).toContainText('Kept offline');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('saved')!));
  expect(saved.content[0].content).toContainEqual({
    type: 'attachmentReference',
    attrs: { attachmentId: '0199a1b0-0000-7000-8000-000000000011' },
  });
  expect(JSON.stringify(saved)).not.toContain('Journey');
  await page.evaluate(() => localStorage.setItem('failDraft', 'true'));
  await file.click();
  await expect(page.getByRole('alert')).toContainText('Your changes are still here');
  expect(await page.evaluate(() => localStorage.getItem('openedFile'))).toBeNull();
  await page.evaluate(() => localStorage.removeItem('failDraft'));
  await file.focus();
  await file.press('Enter');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('openedFile')))
    .toBe('0199a1b0-0000-7000-8000-000000000011');
  await page.screenshot({ path: testInfo.outputPath('inline-file-mobile.png'), fullPage: true });
  await page.reload();
  await expect(file).toContainText('Journey notes — यात्रा.pdf');
  await page.evaluate(() => localStorage.setItem('failOpenFile', 'true'));
  await file.click();
  await expect(page.getByRole('alert')).toContainText('Try again when online');
  await expect(editor).toContainText('Trip documents');
  await page.evaluate(() => window.dispatchEvent(new Event('removeFile')));
  await expect(file).toContainText('Unavailable file');
  await expect(file).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('saved'))).toContain(
    '0199a1b0-0000-7000-8000-000000000011',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('file picker handles processing, search misses and phone-width filenames', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Files ');
  await editor.press('End');
  await page.getByRole('button', { name: 'Insert file', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Choose a file' });
  const search = picker.getByRole('textbox', { name: 'Files attached to this note' });
  await search.fill('missing');
  await expect(picker.getByText('No matching files. Try another name.')).toBeVisible();
  await search.fill('');
  await page.evaluate(() => localStorage.setItem('failDraft', 'true'));
  await picker.getByRole('button', { name: 'Add file', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your changes are still here');
  expect(await page.evaluate(() => localStorage.getItem('pickedFile'))).toBeNull();
  await page.evaluate(() => localStorage.removeItem('failDraft'));
  await picker.getByRole('button', { name: 'Add file', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pickedFile'))).toBe('true');
  await page.screenshot({ path: testInfo.outputPath('file-picker-mobile.png'), fullPage: true });
  await picker.getByRole('button', { name: /Very-long-document/ }).click();
  const file = page.locator('.tiptap [data-attachment-reference]');
  await expect(file).toHaveAttribute('aria-disabled', 'true');
  await file.click({ force: true });
  await expect(page.getByRole('alert')).toContainText('not ready');
  expect(await page.evaluate(() => localStorage.getItem('openedFile'))).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const bounds = await file.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(350);
  await page.screenshot({
    path: testInfo.outputPath('processing-file-mobile.png'),
    fullPage: true,
  });
});

test('preserves conflicting content and saves a separate copy without publishing the original', async ({
  page,
}) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Unfinished local version');
  await page.evaluate(() => window.dispatchEvent(new Event('noteConflict')));
  await expect(page.getByText(/This note changed elsewhere/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await page.evaluate(() => localStorage.setItem('failCopy', 'true'));
  await page.getByRole('button', { name: 'Save as separate note' }).click();
  await expect(page.getByText('Could not queue your draft copy.')).toBeVisible();
  await expect(editor).toHaveText('Unfinished local version');
  await page.evaluate(() => localStorage.removeItem('failCopy'));
  await page.getByRole('button', { name: 'Save as separate note' }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('copied')))
    .toContain('Unfinished local version');
  const storage = await page.evaluate(() => ({
    copied: localStorage.getItem('copied'),
    draft: localStorage.getItem('draft'),
    saved: localStorage.getItem('saved'),
  }));
  expect(storage.draft).toBe(storage.copied);
  expect(storage.saved).toBeNull();
});

async function tool(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  // Tiptap restores focus in requestAnimationFrame after a toolbar action.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test('picks structured backlinks, resolves renames and preserves drafts before navigation', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Reference [[Read');
  const picker = page.getByRole('region', { name: 'Choose a note' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'Reading notes First reference', exact: true }).click();
  const link = page.locator('.tiptap [data-note-reference]');
  await expect(link).toHaveText('[[Reading notes]]');
  await editor.focus();
  await editor.press('ControlOrMeta+a');
  await tool(page, 'Bold');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('saved')!));
  expect(saved.content[0].content).toContainEqual({
    type: 'noteReference',
    attrs: { noteId: '0199a1b0-0000-7000-8000-000000000001' },
    marks: [{ type: 'bold' }],
  });
  await page.evaluate(() => window.dispatchEvent(new Event('renameReference')));
  await expect(link).toHaveText('[[Renamed reading notes]]');
  await page.evaluate(() => localStorage.setItem('failDraft', 'true'));
  await link.click();
  await expect(page.getByRole('alert')).toContainText('Your changes are still here');
  expect(await page.evaluate(() => localStorage.getItem('openedNote'))).toBeNull();
  await page.evaluate(() => localStorage.removeItem('failDraft'));
  await link.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('openedNote')))
    .toBe('0199a1b0-0000-7000-8000-000000000001');
  await page
    .getByRole('region', { name: 'Linked from' })
    .getByRole('button', { name: 'Weekly review' })
    .click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('openedNote')))
    .toBe('0199a1b0-0000-7000-8000-000000000003');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('backlinks-mobile.png'), fullPage: true });
});

test('checkpoints changed drafts every ten minutes and on close without publishing the note', async ({
  page,
}) => {
  await page.clock.install();
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await page.clock.fastForward(600001);
  expect(await page.evaluate(() => localStorage.getItem('checkpoints'))).toBeNull();
  await editor.fill('An unfinished thought');
  await page.clock.fastForward(600001);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('checkpoints') ?? '[]').length))
    .toBe(1);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('checkpoints')!)[0].reason),
  ).toBe('interval');
  expect(await page.evaluate(() => localStorage.getItem('saved'))).toBeNull();
  await page.clock.fastForward(600001);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('checkpoints')!).length)).toBe(
    1,
  );
  await editor.fill('A later unfinished thought');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('checkpoints') ?? '[]').length))
    .toBe(2);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('checkpoints')!)[1].reason),
  ).toBe('session_end');
  expect(await page.evaluate(() => localStorage.getItem('saved'))).toBeNull();
});

test('formats, checks items, validates links, and saves a bounded mobile layout', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  // Select the first paragraph explicitly: Ctrl+Home handling varies with the
  // installed browser/host keyboard shortcuts and is not what this test covers.
  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element.firstElementChild!);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await tool(page, 'Heading 1');
  await expect(page.locator('.tiptap h1')).toHaveText('A clearer day');
  await tool(page, 'Undo');
  await expect(page.locator('.tiptap h1')).toHaveCount(0);
  await tool(page, 'Redo');
  await expect(page.locator('.tiptap h1')).toHaveCount(1);
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    element.focus();
  });
  await editor.press('Enter');
  await tool(page, 'Bold');
  await page.keyboard.insertText('A bold thought');
  await expect(page.locator('.tiptap strong')).toHaveText('A bold thought');
  await tool(page, 'Bold');
  await editor.press('Enter');
  await tool(page, 'Checklist');
  await page.keyboard.insertText('Read a chapter');
  const checkbox = page.getByRole('checkbox');
  await expect(checkbox).toHaveCount(1);
  await checkbox.check();
  await page.locator('.tiptap h1').evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await tool(page, 'Link');
  await page.getByLabel('Link address').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('https');
  await page.getByLabel('Link address').fill('https://example.test/reading');
  await page.getByRole('button', { name: 'Apply link', exact: true }).click();
  await expect(page.locator('.tiptap a')).toHaveAttribute('href', 'https://example.test/reading');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('saved'))).not.toBeNull();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('saved')!));
  expect(saved.content[0].type).toBe('heading');
  expect(saved.content).toContainEqual(
    expect.objectContaining({
      type: 'taskList',
      content: [expect.objectContaining({ attrs: { checked: true } })],
    }),
  );
  expect(await editor.innerText()).toContain('One small step.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('editor-mobile.png'), fullPage: true });
});

test('recovers drafts after reload and stays open when storage fails', async ({ page }) => {
  await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Note content' });
  await editor.fill('Recovered नमस्ते draft');
  await expect(page.getByRole('status')).toHaveText('Draft saved on this device.');
  await page.reload();
  await expect(editor).toHaveText('Recovered नमस्ते draft');
  await expect(page.getByRole('status')).toContainText('Recovered your draft');
  await page.evaluate(() => localStorage.setItem('failDraft', 'true'));
  await editor.fill('Keep this unsaved edit');
  await expect(page.getByRole('alert')).toContainText('Could not save this draft');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your changes are still here');
  expect(await page.evaluate(() => localStorage.getItem('closed'))).toBeNull();
  await expect(editor).toHaveText('Keep this unsaved edit');
  await page.evaluate(() => localStorage.removeItem('failDraft'));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('saved')))
    .toContain('Keep this unsaved edit');
});
