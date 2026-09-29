import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Switch, Text, View } from 'react-native';
import { Button, Field, styles } from './components';
import { signIn, type Session } from './auth';

export function AuthScreen({ onSession }: { onSession: (session: Session) => void }) {
  const [signup, setSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      onSession(
        await signIn({ email: email.trim(), password, name: name.trim(), signup, consent }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.page, { paddingTop: 64 }]}
      >
        <Text style={styles.eyebrow}>PERSONALSPACE</Text>
        <Text style={styles.title}>A little space.{'\n'}A clearer day.</Text>
        <Text style={styles.subtitle}>
          Your thoughts and to-dos, together. Capture what matters and come back to it.
        </Text>
        <Text style={styles.label}>{signup ? 'Create your account' : 'Welcome back'}</Text>
        {signup && (
          <Field label="Your name" autoComplete="name" value={name} onChangeText={setName} />
        )}
        <Field
          label="Email"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          value={email}
          onChangeText={setEmail}
        />
        <Field
          label="Password"
          secureTextEntry
          autoCapitalize="none"
          autoComplete={signup ? 'new-password' : 'current-password'}
          value={password}
          onChangeText={setPassword}
        />
        {signup && (
          <>
            <Text style={styles.subtitle}>
              Use at least 10 characters. This is a development preview; use test data only.
            </Text>
            <View style={styles.row}>
              <Switch
                accessibilityLabel="I am 18 or older and agree to use this development preview with test data"
                value={consent}
                onValueChange={setConsent}
              />
              <Text style={[styles.subtitle, { flex: 1 }]}>
                I am 18+ and agree to use this development preview with test data.
              </Text>
            </View>
          </>
        )}
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          label={busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
          disabled={
            busy || !email || password.length < 10 || (signup && (!name.trim() || !consent))
          }
          onPress={() => void submit()}
        />
        <Button
          secondary
          label={signup ? 'Already have an account? Sign in' : 'New here? Create an account'}
          disabled={busy}
          onPress={() => {
            setSignup(!signup);
            setError('');
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
