import type { FC, ReactNode } from 'react';

/**
 * natui's typed component API. Each component is a host-element tag (a plain
 * string the reconciler passes through as the node `kind`) cast to a typed FC
 * so JSX gets full prop checking with zero runtime cost.
 */

// ---------------------------------------------------------------------------
// Shared prop shapes
// ---------------------------------------------------------------------------

export type Color = string; // '#RRGGBB' or '#RRGGBBAA'

export interface EdgeInsets {
  top?: number;
  bottom?: number;
  leading?: number;
  trailing?: number;
}

export interface Frame {
  width?: number;
  height?: number;
  minWidth?: number;
  maxWidth?: number | 'infinity';
  minHeight?: number;
  maxHeight?: number | 'infinity';
}

export interface CommonProps {
  padding?: number | EdgeInsets;
  background?: Color;
  cornerRadius?: number;
  frame?: Frame;
  opacity?: number;
  disabled?: boolean;
  hidden?: boolean;
  /** Foreground color. */
  color?: Color;
  /** Tooltip. */
  help?: string;
  /** Assistive-tech label (VoiceOver / Narrator). */
  accessibilityLabel?: string;
  /** Assistive-tech hint describing the result of activating the element. */
  accessibilityHint?: string;
  /** Stable identifier for UI automation (AX identifier / AutomationId). */
  accessibilityIdentifier?: string;
  key?: string | number;
}

export interface ContainerProps extends CommonProps {
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface VStackProps extends ContainerProps {
  spacing?: number;
  alignment?: 'leading' | 'center' | 'trailing';
}

export interface HStackProps extends ContainerProps {
  spacing?: number;
  alignment?: 'top' | 'center' | 'bottom';
}

export type ZStackProps = ContainerProps;

export interface SpacerProps extends CommonProps {
  minLength?: number;
}

export type DividerProps = CommonProps;

export interface ScrollViewProps extends ContainerProps {
  axis?: 'vertical' | 'horizontal';
}

export type ListProps = ContainerProps;

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export type FontStyle =
  | 'largeTitle'
  | 'title'
  | 'title2'
  | 'title3'
  | 'headline'
  | 'body'
  | 'callout'
  | 'caption';

export interface TextProps extends CommonProps {
  children?: ReactNode;
  font?: FontStyle;
  /** Point size; when set, a system font of this size replaces `font` (weight still applies). */
  size?: number;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  italic?: boolean;
  strikethrough?: boolean;
  monospaced?: boolean;
  lineLimit?: number;
}

export interface ImageProps extends CommonProps {
  /** SF Symbols name on macOS; mapped to Segoe Fluent glyphs on Windows. */
  systemName: string;
  size?: number;
}

export interface ProgressViewProps extends CommonProps {
  /** 0..1. Omit for an indeterminate spinner. */
  value?: number;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface ButtonProps extends CommonProps {
  children?: ReactNode;
  onPress?: () => void;
  variant?: 'automatic' | 'bordered' | 'prominent' | 'plain' | 'link';
  role?: 'destructive' | 'cancel';
}

export interface TextFieldProps extends CommonProps {
  value: string;
  placeholder?: string;
  secure?: boolean;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

export interface ToggleProps extends CommonProps {
  children?: ReactNode;
  value: boolean;
  onChange?: (value: boolean) => void;
}

export interface SliderProps extends CommonProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
}

export interface PickerOption {
  value: string;
  label: string;
}

export interface PickerProps extends CommonProps {
  value: string;
  options: PickerOption[];
  label?: string;
  onChange?: (value: string) => void;
}

// ---------------------------------------------------------------------------
// Host components
// ---------------------------------------------------------------------------

function host<P>(kind: string): FC<P> {
  return kind as unknown as FC<P>;
}

export const VStack = host<VStackProps>('VStack');
export const HStack = host<HStackProps>('HStack');
export const ZStack = host<ZStackProps>('ZStack');
export const Spacer = host<SpacerProps>('Spacer');
export const Divider = host<DividerProps>('Divider');
export const ScrollView = host<ScrollViewProps>('ScrollView');
export const List = host<ListProps>('List');
export const Text = host<TextProps>('Text');
export const Image = host<ImageProps>('Image');
export const ProgressView = host<ProgressViewProps>('ProgressView');
export const Button = host<ButtonProps>('Button');
export const TextField = host<TextFieldProps>('TextField');
export const Toggle = host<ToggleProps>('Toggle');
export const Slider = host<SliderProps>('Slider');
export const Picker = host<PickerProps>('Picker');
