export const ACCENT_COLORS = ['blue', 'purple', 'rose', 'teal', 'amber', 'slate'] as const;
export type AccentColor = typeof ACCENT_COLORS[number];

/** A missing/obsolete setting uses the default purple theme without a write. */
export function parseAccentColor(value: string | null): AccentColor {
  return (ACCENT_COLORS as readonly string[]).includes(value ?? '') ? value as AccentColor : 'purple';
}
