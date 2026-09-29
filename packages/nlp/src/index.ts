export type Suggestion = { type: 'inbox' | 'note' | 'task'; reason: string };
export function suggestCapture(text: string): Suggestion {
  if (/^https?:\/\//i.test(text.trim()))
    return { type: 'inbox', reason: 'Save this link to your inbox.' };
  if (
    /^(todo|task|remember to|need to|call|buy|finish|send|read)\b/i.test(text.trim()) &&
    text.trim().length <= 500
  )
    return { type: 'task', reason: 'Looks like something to do.' };
  return { type: 'inbox', reason: 'Save now. Choose where it belongs later.' };
}
