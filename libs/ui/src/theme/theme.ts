/**
 * The design language of `tokens.ts`, expressed as Ant Design theme configs.
 *
 * One place decides what antd looks like across every PlantOps console. A
 * screen that needs a colour asks antd for its token (`theme.useToken()`) or
 * imports from `tokens.ts`; it never writes a hex literal, because the value
 * that is correct in light mode is wrong in dark mode and a literal cannot know
 * which one is showing.
 *
 * ## Why `cssVar` is on
 *
 * With CSS-variable mode antd emits `--ant-color-primary: …` once and every
 * component references the variable, so switching colour mode re-paints from a
 * single `:root` rule instead of re-serialising the whole style sheet. That is
 * what makes the mode toggle instant, and it also keeps the server-rendered
 * style payload small — which matters because these consoles are Next.js apps
 * that ship their antd styles from the server on first paint.
 */

import type { ThemeConfig } from 'antd';
import { theme as antdTheme } from 'antd';

import {
  type ColorMode,
  layout,
  navSurface,
  neutral,
  palette,
  radius,
  shadow,
  spacing,
  typography,
} from './tokens';

/** Tokens that are the same in both modes: type, rhythm, geometry. */
const sharedTokens: ThemeConfig['token'] = {
  colorPrimary: palette.primary,
  colorInfo: palette.info,
  colorSuccess: palette.success,
  colorWarning: palette.warning,
  colorError: palette.error,

  fontFamily: typography.fontFamily,
  fontFamilyCode: typography.fontFamilyMono,
  fontSize: typography.fontSize,
  fontSizeSM: typography.fontSizeSm,
  fontSizeLG: typography.fontSizeLg,

  borderRadius: radius.md,
  borderRadiusSM: radius.sm,
  borderRadiusLG: radius.lg,

  controlHeight: 36,
  padding: spacing.md,
  margin: spacing.md,

  wireframe: false,
};

/**
 * Component overrides shared by both modes.
 *
 * Kept to the handful of places where antd's default is wrong *for this
 * product* rather than merely different from someone's taste: denser tables
 * because these screens list hundreds of users, a flat navigation surface
 * because the sidebar supplies its own colours, and a Layout whose header does
 * not fight the content for attention.
 */
const sharedComponents: ThemeConfig['components'] = {
  Layout: {
    headerHeight: layout.headerHeight,
    headerPadding: `0 ${spacing.lg}px`,
    siderBg: navSurface.background,
    triggerBg: navSurface.backgroundHover,
    triggerColor: navSurface.text,
  },
  Menu: {
    itemHeight: 38,
    itemMarginInline: spacing.xs,
    itemBorderRadius: radius.md,
    // The sidebar keeps its dark surface in both colour modes (see tokens.ts).
    darkItemBg: 'transparent',
    darkSubMenuItemBg: 'transparent',
    darkItemColor: navSurface.text,
    darkItemHoverBg: navSurface.backgroundHover,
    darkItemHoverColor: navSurface.textSelected,
    darkItemSelectedBg: navSurface.backgroundSelected,
    darkItemSelectedColor: navSurface.textSelected,
    darkPopupBg: navSurface.background,
  },
  Table: {
    headerBorderRadius: 0,
    cellPaddingBlock: spacing.sm,
    cellPaddingInline: spacing.md,
  },
  Card: {
    boxShadowTertiary: shadow.card,
  },
  Descriptions: {
    itemPaddingBottom: spacing.sm,
  },
  Form: {
    itemMarginBottom: spacing.md,
  },
};

const lightTheme: ThemeConfig = {
  algorithm: antdTheme.defaultAlgorithm,
  cssVar: {},
  hashed: true,
  token: {
    ...sharedTokens,
    colorBgLayout: neutral[100],
    colorBgContainer: neutral[0],
    colorBgElevated: neutral[0],
    colorBorder: neutral[300],
    colorBorderSecondary: neutral[200],
    colorText: neutral[800],
    colorTextSecondary: neutral[600],
    colorTextTertiary: neutral[500],
    colorTextQuaternary: neutral[400],
    boxShadowSecondary: shadow.popup,
  },
  components: {
    ...sharedComponents,
    Layout: {
      ...sharedComponents?.Layout,
      headerBg: neutral[0],
      bodyBg: neutral[100],
    },
  },
};

const darkTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  cssVar: {},
  hashed: true,
  token: {
    ...sharedTokens,
    colorBgLayout: neutral[950],
    colorBgContainer: neutral[900],
    colorBgElevated: neutral[800],
    colorBorder: '#2A3538',
    colorBorderSecondary: '#1F292C',
    colorText: '#E4EAEC',
    colorTextSecondary: '#A9B5B9',
    colorTextTertiary: '#7E8C91',
    boxShadowSecondary: '0 6px 16px rgba(0, 0, 0, 0.45)',
  },
  components: {
    ...sharedComponents,
    Layout: {
      ...sharedComponents?.Layout,
      headerBg: neutral[900],
      bodyBg: neutral[950],
    },
  },
};

/** The antd theme for a colour mode. The only way to obtain one. */
export function plantOpsTheme(mode: ColorMode): ThemeConfig {
  return mode === 'dark' ? darkTheme : lightTheme;
}
