import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { backgroundGradient, brandGradient, theme } from '../lib/theme';

/** Фон, общий для всех экранов. */
export function Background({ children }: { children: ReactNode }) {
  return (
    <LinearGradient colors={backgroundGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.fill}>
      {children}
    </LinearGradient>
  );
}

/** Обложка с плейсхолдером и плавным появлением. */
export function Artwork({
  uri,
  size,
  radius = 12,
  style,
}: {
  uri: string | null | undefined;
  size?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const box: StyleProp<ViewStyle> = [
    { borderRadius: radius, backgroundColor: theme.surfaceElevated, overflow: 'hidden' },
    size ? { width: size, height: size } : styles.fill,
    style,
  ];

  if (!uri) {
    return (
      <View style={[box, styles.center]}>
        <Ionicons name="musical-note" size={size ? size / 2.5 : 40} color={theme.textTertiary} />
      </View>
    );
  }

  return (
    <View style={box}>
      <Image source={{ uri }} style={styles.fill} contentFit="cover" transition={250} />
    </View>
  );
}

/** Основная кнопка с индикатором загрузки. */
export function PrimaryButton({
  title,
  icon,
  loading = false,
  disabled = false,
  onPress,
  style,
}: {
  title: string;
  icon?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || loading;

  return (
    <Pressable onPress={onPress} disabled={inactive} style={style}>
      <LinearGradient
        colors={brandGradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.primaryButton, inactive && styles.dimmed]}
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <>
            {icon ? <Ionicons name={icon} size={18} color="#fff" /> : null}
            <Text style={styles.primaryButtonText}>{title}</Text>
          </>
        )}
      </LinearGradient>
    </Pressable>
  );
}

/** Второстепенная кнопка на полупрозрачной подложке. */
export function SecondaryButton({
  title,
  icon,
  onPress,
  disabled = false,
  tint = theme.textPrimary,
  style,
}: {
  title: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.secondaryButton, disabled && styles.dimmed, style]}
    >
      {icon ? <Ionicons name={icon} size={18} color={tint} /> : null}
      <Text style={[styles.secondaryButtonText, { color: tint }]}>{title}</Text>
    </Pressable>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <View style={styles.row}>
        <Ionicons name="warning" size={16} color={theme.pass} />
        <Text style={styles.errorText}>{message}</Text>
      </View>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={styles.errorRetry}>Попробовать снова</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function GenreChip({ title }: { title: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{title}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function EmptyState({
  icon,
  title,
  message,
  actionTitle,
  onAction,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  message: string;
  actionTitle?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <Ionicons name={icon} size={44} color={theme.accent} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyMessage}>{message}</Text>
      {actionTitle && onAction ? (
        <PrimaryButton title={actionTitle} onPress={onAction} style={styles.emptyAction} />
      ) : null}
    </View>
  );
}

/** Горизонтальные полоски весов жанров. */
export function TasteBars({ values }: { values: Array<{ genre: string; weight: number }> }) {
  const max = Math.max(...values.map((item) => item.weight), 0.0001);

  return (
    <View style={{ gap: 8 }}>
      {values.map((item) => (
        <View key={item.genre} style={styles.row}>
          <Text style={styles.barLabel} numberOfLines={1}>
            {item.genre}
          </Text>
          <View style={styles.barTrack}>
            <LinearGradient
              colors={brandGradient}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={[styles.barFill, { width: `${Math.max(4, (item.weight / max) * 100)}%` }]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Экран-заглушка, пока восстанавливается сессия. */
export function Loader({ label }: { label?: string }) {
  return (
    <View style={[styles.fill, styles.center, { gap: 14 }]}>
      <ActivityIndicator size="large" color={theme.accent} />
      {label ? <Text style={styles.emptyMessage}>{label}</Text> : null}
    </View>
  );
}

/** Экран для случая «забыли положить .env». */
export function ConfigurationNeeded() {
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Text style={styles.emptyTitle}>Приложение не настроено</Text>
      <Text style={styles.emptyMessage}>
        Создайте файл .env по образцу .env.example и укажите адрес проекта и anon-ключ
        (Supabase → Project Settings → API), затем перезапустите expo start.
      </Text>
      <Card style={{ padding: 14 }}>
        <Text style={styles.mono}>cp .env.example .env</Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },

  primaryButton: {
    height: 54,
    borderRadius: theme.radius,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  dimmed: { opacity: 0.55 },

  secondaryButton: {
    height: 50,
    borderRadius: theme.radius,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '500' },

  errorBanner: {
    padding: 14,
    borderRadius: 14,
    gap: 10,
    backgroundColor: 'rgba(250,82,92,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(250,82,92,0.35)',
  },
  errorText: { flex: 1, color: theme.textPrimary, fontSize: 13, lineHeight: 18 },
  errorRetry: { color: theme.accent, fontSize: 13, fontWeight: '600' },

  chip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  chipText: { color: theme.textPrimary, fontSize: 12, fontWeight: '500' },

  card: {
    backgroundColor: theme.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.border,
  },

  emptyState: { alignItems: 'center', justifyContent: 'center', gap: 12, padding: 28 },
  emptyTitle: { color: theme.textPrimary, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  emptyMessage: { color: theme.textSecondary, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  emptyAction: { marginTop: 6, alignSelf: 'stretch' },

  barLabel: { color: theme.textSecondary, fontSize: 12, width: 92 },
  barTrack: {
    flex: 1,
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  barFill: { height: 8, borderRadius: 999 },

  mono: { color: theme.textPrimary, fontFamily: 'Courier', fontSize: 13 },
});
