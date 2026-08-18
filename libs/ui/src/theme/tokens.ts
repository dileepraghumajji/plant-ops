/**
 * The PlantOps design language, as raw values (Doc 09 preamble).
 *
 * Doc 09 mandates no component library and leaves visuals to "the project's
 * design language" — this file *is* that design language, written down once so
 * that `admin-web`, and the gatepass and visitor consoles that follow it, are
 * recognisably the same product rather than three applications that happen to
 * share an API.
 *
 * Everything here is a plain value, not an Ant Design concept. {@link theme.ts}
 * translates them into an antd `ThemeConfig`; a chart, an email template or a
 * future non-antd surface can read the same numbers without importing antd.
 *
 * ## The palette, and why it is this one
 *
 * PlantOps administers industrial sites — plants, gates, departments, shift
 * supervisors. Two things follow. First, the interface is used for long
 * stretches on cheap monitors in bright rooms, so the neutrals are cool slates
 * with real contrast rather than the low-contrast greys that photograph well on
 * a designer's laptop. Second, and more importantly: **red, amber and green
 * already mean something on a plant floor**. Reserving them for status is not a
 * stylistic preference here, it is the reason the brand colour is a deep teal.
 * A primary button must never be mistakable for a running/fault indicator.
 */

/**
 * Brand and status colours.
 *
 * `primary` is the only decorative colour in the set; the other four are
 * semantic and must not be borrowed for emphasis, per the note above.
 */
export const palette = {
  /** Deep teal — brand, primary actions, active navigation. */
  primary: '#0E7C66',
  /** Hover/active step of the primary ramp, used where antd wants a lighter one. */
  primaryHover: '#12977C',
  /** Tint behind selected rows and active menu items. */
  primarySoft: '#E6F4F0',

  /** Informational, never a call to action. */
  info: '#1668DC',
  /** Completed, healthy, active. */
  success: '#2F9E44',
  /** Degraded, expiring, needs attention — locked accounts, expiring bindings. */
  warning: '#D48806',
  /** Failed, denied, revoked. */
  error: '#CF3B33',
} as const;

/**
 * Neutrals, coolest to warmest-lightest.
 *
 * The console's dark surfaces (the sidebar, the dark colour mode) come from the
 * `900`–`700` end; page chrome from `100`–`300`.
 */
export const neutral = {
  0: '#FFFFFF',
  50: '#F7F9F9',
  100: '#EFF2F3',
  200: '#E1E6E8',
  300: '#CBD3D6',
  400: '#9AA7AC',
  500: '#6C7A80',
  600: '#4C585D',
  700: '#333D41',
  800: '#1E2629',
  900: '#121A1C',
  950: '#0B1113',
} as const;

/**
 * The navigation surface, in both colour modes.
 *
 * Held apart from {@link neutral} because the sidebar is intentionally dark in
 * *both* modes: it is the one region whose appearance should not change when a
 * user flips the theme, so that muscle memory for "where the menu is" survives.
 */
export const navSurface = {
  background: neutral[900],
  backgroundHover: '#1B2528',
  backgroundSelected: '#14342E',
  text: '#B7C2C6',
  textSelected: '#FFFFFF',
  border: '#1F292C',
} as const;

/**
 * Typography.
 *
 * Inter when the host page provides it, then the platform UI stack. The lib
 * deliberately loads no webfont: a shared component library that injects a
 * network request into every consuming app is a decision each app should make
 * for itself.
 */
export const typography = {
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  fontFamilyMono:
    "'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  /** Body size. 14 is antd's default and the right density for admin tables. */
  fontSize: 14,
  fontSizeSm: 12,
  fontSizeLg: 16,
  fontSizeHeading: 20,
} as const;

/** A 4px rhythm. Every gap, pad and inset in the library is one of these. */
export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 10,
  pill: 999,
} as const;

/** Fixed chrome dimensions the shell and its consumers agree on. */
export const layout = {
  headerHeight: 56,
  sidebarWidth: 248,
  sidebarCollapsedWidth: 64,
  /** Maximum width of a reading-oriented page body (forms, detail panels). */
  contentMaxWidth: 1440,
} as const;

/** The elevation steps used by cards, dropdowns and drawers. */
export const shadow = {
  card: '0 1px 2px rgba(11, 17, 19, 0.04), 0 1px 3px rgba(11, 17, 19, 0.06)',
  popup: '0 6px 16px rgba(11, 17, 19, 0.12), 0 3px 6px rgba(11, 17, 19, 0.08)',
} as const;

/** The two colour modes the theme is defined for. */
export type ColorMode = 'light' | 'dark';
