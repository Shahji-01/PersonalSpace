import { parseTaskDates, type TaskDates } from './dates';
export { parseTaskDates } from './dates';
export type Suggestion = { type: 'inbox' | 'note' | 'task'; reason: string; dates?: TaskDates };
export function suggestCapture(text: string, today?: string): Suggestion {
  if (/^https?:\/\//i.test(text.trim()))
    return { type: 'inbox', reason: 'Save this link to your inbox.' };
  if (
    !/\?|^(did|do|does|can|could|should|kya)\b|^क्या/i.test(text.trim()) &&
    (/^(todo|task|remember to|need to|call|buy|finish|send|read)\b/i.test(text.trim()) ||
      /\b(?:karna|bhejna|kharidna|padhna)\b|करना|भेजना|खरीदना|पढ़ना/u.test(text)) &&
    text.trim().length <= 500
  ) {
    const dates = today ? parseTaskDates(text, today) : undefined;
    return {
      type: 'task',
      reason: dates?.needsDateReview
        ? 'Looks like a task. Choose dates explicitly for ambiguous or repeating phrases.'
        : 'Looks like something to do. Review the suggested dates before saving.',
      ...(dates ? { dates } : {}),
    };
  }
  return { type: 'inbox', reason: 'Save now. Choose where it belongs later.' };
}
