/**
 * Industrial dark field theme.
 *
 * Near-black blue-green ground, dark cards with thin borders, bright cyan
 * accent. Status colour is never the only carrier of meaning — every state also
 * has a text label, because a result must stay readable in sunlight, on a
 * cracked screen, and to a colour-blind operator.
 */
export const colors = {
  background: '#050B0E',
  surface: '#0C161A',
  surfaceRaised: '#122228',
  border: '#1E353D',
  borderStrong: '#2C4C57',
  accent: '#3DE0D5',
  accentDim: '#1B8C86',
  text: '#E4F1F3',
  textMuted: '#8AA5AC',
  textFaint: '#5C777F',
  pass: '#3DE0D5',
  warning: '#F5A524',
  error: '#FF5A5A',
  withheld: '#F5A524',
  experimental: '#B07CFF',
  overlay: 'rgba(5, 11, 14, 0.88)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

export const typography = {
  wordmark: { fontSize: 22, letterSpacing: 8, fontWeight: '700' as const },
  title: { fontSize: 18, letterSpacing: 1.6, fontWeight: '700' as const },
  sectionTitle: { fontSize: 12, letterSpacing: 1.8, fontWeight: '700' as const },
  body: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 12, lineHeight: 17 },
  mono: { fontSize: 13, fontVariant: ['tabular-nums'] as ('tabular-nums')[] },
  value: { fontSize: 20, fontWeight: '700' as const },
} as const;

/** Minimum touch target for gloved field use. */
export const MIN_TOUCH_SIZE = 48;

export type QualityTone = 'pass' | 'warning' | 'error' | 'neutral' | 'experimental';

export function toneColor(tone: QualityTone): string {
  switch (tone) {
    case 'pass':
      return colors.pass;
    case 'warning':
      return colors.warning;
    case 'error':
      return colors.error;
    case 'experimental':
      return colors.experimental;
    default:
      return colors.textMuted;
  }
}

/** Map a quality grade to a tone. The grade letter is always shown as well. */
export function gradeTone(grade: 'A' | 'B' | 'C' | 'INVALID'): QualityTone {
  switch (grade) {
    case 'A':
      return 'pass';
    case 'B':
      return 'neutral';
    case 'C':
      return 'warning';
    default:
      return 'error';
  }
}
