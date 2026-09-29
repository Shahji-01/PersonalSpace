import { describe, expect, it } from 'vitest';
import { captureSchema, commandSchema, signupSchema } from './index';
const id = '01900000-0000-7000-8000-000000000001';
describe('boundary validation', () => {
  it('rejects ownership overrides and unknown commands', () => {
    expect(captureSchema.safeParse({ id, type: 'inbox', text: 'hi', userId: id }).success).toBe(
      false,
    );
    expect(commandSchema.safeParse({ op: 'transaction.void', id }).success).toBe(false);
  });
  it('validates actual calendar dates and task title limits', () => {
    expect(
      captureSchema.safeParse({ id, type: 'task', text: 'Read', plannedDate: '2026-02-30' })
        .success,
    ).toBe(false);
    expect(captureSchema.safeParse({ id, type: 'task', text: 'a'.repeat(501) }).success).toBe(
      false,
    );
    expect(captureSchema.safeParse({ id, type: 'note', text: 'a'.repeat(501) }).success).toBe(true);
  });
  it('requires explicit age and preview consent', () => {
    expect(
      signupSchema.safeParse({ name: 'A', email: 'a@example.test', password: 'long-test-password' })
        .success,
    ).toBe(false);
  });
});
