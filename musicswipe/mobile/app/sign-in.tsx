import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Background, ErrorBanner, PrimaryButton, SecondaryButton } from '../components/ui';
import { useAuth } from '../lib/auth';
import { describeError } from '../lib/supabase';
import { theme } from '../lib/theme';

export default function SignIn() {
  const { signIn, signUp, signInAnonymously } = useAuth();

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.includes('@') && password.length >= 6 && !busy;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(await describeError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Background>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <View style={styles.header}>
            <Ionicons name="flame" size={52} color={theme.accent} />
            <Text style={styles.title}>MusicSwipe</Text>
            <Text style={styles.subtitle}>
              Пришлите ссылку на свой плейлист — и свайпайте треки, которые вам подойдут
            </Text>
          </View>

          <View style={{ gap: 14 }}>
            <Field
              icon="mail"
              placeholder="Почта"
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
            />
            <Field
              icon="lock-closed"
              placeholder="Пароль"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>

          {error ? <ErrorBanner message={error} /> : null}

          <View style={{ gap: 12 }}>
            <PrimaryButton
              title={mode === 'sign-in' ? 'Войти' : 'Создать аккаунт'}
              icon="arrow-forward"
              loading={busy}
              disabled={!canSubmit}
              onPress={() =>
                run(() =>
                  mode === 'sign-in'
                    ? signIn(email.trim(), password)
                    : signUp(email.trim(), password),
                )
              }
            />

            <Text
              style={styles.switch}
              onPress={() => {
                setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
                setError(null);
              }}
            >
              {mode === 'sign-in' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти'}
            </Text>
          </View>

          <View style={styles.divider}>
            <View style={styles.line} />
            <Text style={styles.dividerText}>или</Text>
            <View style={styles.line} />
          </View>

          <SecondaryButton
            title="Продолжить без регистрации"
            icon="person-circle-outline"
            disabled={busy}
            onPress={() => run(signInAnonymously)}
          />

          <Text style={styles.note}>
            Гостевой вход создаёт временный аккаунт: лайки и вкусовой профиль сохраняются,
            но восстановить их на другом устройстве не получится.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Background>
  );
}

function Field({
  icon,
  ...props
}: { icon: keyof typeof Ionicons.glyphMap } & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Ionicons name={icon} size={18} color={theme.textTertiary} />
      <TextInput
        {...props}
        placeholderTextColor={theme.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: 24, paddingTop: 72, gap: 26 },

  header: { alignItems: 'center', gap: 12 },
  title: { color: theme.textPrimary, fontSize: 34, fontWeight: '800' },
  subtitle: {
    color: theme.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 21,
  },

  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 54,
    paddingHorizontal: 16,
    borderRadius: theme.radius,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  input: { flex: 1, color: theme.textPrimary, fontSize: 16 },

  switch: { color: theme.textSecondary, fontSize: 14, textAlign: 'center' },

  divider: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  line: { flex: 1, height: 1, backgroundColor: 'rgba(255,255,255,0.12)' },
  dividerText: { color: theme.textTertiary, fontSize: 12 },

  note: { color: theme.textTertiary, fontSize: 12, textAlign: 'center', lineHeight: 17 },
});
