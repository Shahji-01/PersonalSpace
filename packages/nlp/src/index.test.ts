import { describe, expect, it } from 'vitest';
import { suggestCapture } from './index';
describe('capture suggestions', () => {
  it('does not turn a question or an expense into a task', () => {
    expect(suggestCapture('Did I buy milk?').type).toBe('inbox');
    expect(suggestCapture('Spent 450 on groceries').type).toBe('inbox');
  });
  it('suggests an explicit task without saving it', () =>
    expect(suggestCapture('Call Mom').type).toBe('task'));
  it('preserves links and long text in inbox', () => {
    expect(suggestCapture('https://example.com/task').type).toBe('inbox');
    expect(suggestCapture('Read ' + 'a'.repeat(500)).type).toBe('inbox');
  });
});
