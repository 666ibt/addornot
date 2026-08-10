/** Оформление приложения в одном месте. */
export const theme = {
  background: '#0d0a17',
  surface: '#1c192a',
  surfaceElevated: '#292538',
  border: 'rgba(255,255,255,0.08)',

  accent: '#fc4a73',
  accentSecondary: '#8754fa',

  like: '#33d98c',
  pass: '#fa525c',
  superlike: '#4dadff',

  textPrimary: '#ffffff',
  textSecondary: 'rgba(255,255,255,0.65)',
  textTertiary: 'rgba(255,255,255,0.4)',

  cardRadius: 28,
  radius: 16,
} as const;

/** Градиент фона: три точки, как в исходном нативном клиенте. */
export const backgroundGradient = ['#170d2e', '#0d0a17', '#1f0a24'] as const;

/** Фирменный градиент кнопок и акцентов. */
export const brandGradient = [theme.accentSecondary, theme.accent] as const;
