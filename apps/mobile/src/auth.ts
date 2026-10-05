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

/**
 * Request a password-reset email. Resolves regardless of whether the email has an
 * account — the server never reveals account existence.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await fetch(`${apiUrl}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'personalspace://' },
    body: JSON.stringify({ email, redirectTo: 'personalspace://reset' }),
    signal: AbortSignal.timeout(15000),
  });
}

export const SOCIAL_CALLBACK = 'personalspace://oauth';

/**
 * Begin a Google/Apple sign-in. Asks the server for the provider authorization
 * URL and opens it in the system browser; the provider redirects back to
 * SOCIAL_CALLBACK, which AuthScreen listens for. Requires the provider to be
 * configured on the server (GOOGLE_/APPLE_ env).
 */
export async function startSocialSignIn(provider: 'google' | 'apple'): Promise<void> {
  const { Linking } = await import('react-native');
  const response = await fetch(`${apiUrl}/api/auth/sign-in/social`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'personalspace://' },
    body: JSON.stringify({ provider, callbackURL: SOCIAL_CALLBACK }),
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error('Sign-in with this provider is not available yet.');
  const url =
    data && typeof data === 'object' && 'url' in data ? (data as { url?: string }).url : null;
  if (!url) throw new Error('Could not start sign-in with this provider.');
  await Linking.openURL(url);
}

/** Pull the bearer token from a deep-link callback URL, if present. */
export function tokenFromCallback(url: string): string | null {
  if (!url.startsWith(SOCIAL_CALLBACK)) return null;
  try {
    return new URL(url).searchParams.get('token');
  } catch {
    return null;
  }
}

/** Complete a social sign-in by resolving the account for a returned bearer token. */
export async function completeSocialSession(token: string): Promise<Session> {
  const response = await fetch(`${apiUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}`, Origin: 'personalspace://' },
    signal: AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json().catch(() => null);
  const id =
    data && typeof data === 'object' && 'data' in data
      ? (data as { data?: { id?: string } }).data?.id
      : undefined;
  if (!response.ok || !id) throw new Error('Could not complete sign-in. Try again.');
  const session: Session = { token, user: { id, name: 'You' } };
  await SecureStore.setItemAsync('personalspace.session', JSON.stringify(session));
  return session;
}
