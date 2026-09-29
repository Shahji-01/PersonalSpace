import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

export const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';
const sessionSchema = z.object({
  token: z.string(),
  user: z.object({ id: z.string(), name: z.string() }),
});
export type Session = z.infer<typeof sessionSchema>;
export async function loadSession(): Promise<Session | null> {
  const raw = await SecureStore.getItemAsync('personalspace.session');
  if (!raw) return null;
  const parsed = sessionSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}
export async function signIn(input: {
  email: string;
  password: string;
  name: string;
  signup: boolean;
  consent: boolean;
}): Promise<Session> {
  const response = await fetch(`${apiUrl}/api/auth/${input.signup ? 'sign-up' : 'sign-in'}/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'personalspace://' },
    body: JSON.stringify(
      input.signup
        ? {
            email: input.email,
            password: input.password,
            name: input.name,
            ageConfirmed: input.consent,
            termsAccepted: input.consent,
          }
        : { email: input.email, password: input.password },
    ),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      input.signup
        ? 'Could not create an account. Check your details or try signing in.'
        : 'Could not sign in. Check your email and password.',
    );
  const session = sessionSchema.parse(data);
  await SecureStore.setItemAsync('personalspace.session', JSON.stringify(session));
  return session;
}
export const clearSession = () => SecureStore.deleteItemAsync('personalspace.session');
