import { createElement, Fragment } from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";

export {
  createContext,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";

export type NativeColor =
  | "accent"
  | "primary"
  | "secondary"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "mint"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "purple"
  | "pink"
  | "brown"
  | "gray"
  | "black"
  | "white"
  | (string & {});

export type EdgeInsets =
  | number
  | {
      top?: number;
      trailing?: number;
      bottom?: number;
      leading?: number;
    };

export type FontWeight =
  | "ultralight"
  | "thin"
  | "light"
  | "regular"
  | "medium"
  | "semibold"
  | "bold"
  | "heavy"
  | "black";

export interface CommonProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  background?: NativeColor;
  cornerRadius?: number;
  disabled?: boolean;
  foreground?: NativeColor;
  height?: number;
  hidden?: boolean;
  id?: string;
  maxHeight?: number;
  maxWidth?: number;
  minHeight?: number;
  minWidth?: number;
  opacity?: number;
  padding?: EdgeInsets;
  testID?: string;
  width?: number;
}

export interface ContainerProps extends CommonProps {
  children?: ReactNode;
  spacing?: number;
}

export interface VStackProps extends ContainerProps {
  alignment?: "leading" | "center" | "trailing";
}

export interface HStackProps extends ContainerProps {
  alignment?: "top" | "center" | "bottom" | "firstTextBaseline" | "lastTextBaseline";
}

export interface ZStackProps extends Omit<ContainerProps, "spacing"> {
  alignment?:
    | "topLeading"
    | "top"
    | "topTrailing"
    | "leading"
    | "center"
    | "trailing"
    | "bottomLeading"
    | "bottom"
    | "bottomTrailing";
}

export interface TextProps extends CommonProps {
  children?: ReactNode;
  content?: string | number;
  fontSize?: number;
  fontWeight?: FontWeight;
  lineLimit?: number;
  selectable?: boolean;
  textAlign?: "leading" | "center" | "trailing";
}

export interface ButtonProps extends CommonProps {
  children?: ReactNode;
  onPress: () => void;
  role?: "default" | "cancel" | "destructive";
  title?: string;
}

export interface TextFieldProps extends CommonProps {
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  secure?: boolean;
  value: string;
}

export interface ToggleProps extends CommonProps {
  children?: ReactNode;
  label?: string;
  onChange: (value: boolean) => void;
  value: boolean;
}

export interface SliderProps extends CommonProps {
  maximum?: number;
  minimum?: number;
  onChange: (value: number) => void;
  step?: number;
  value: number;
}

export interface ImageProps extends CommonProps {
  alt?: string;
  fit?: "fit" | "fill";
  source?: string;
  systemName?: string;
}

export interface ScrollViewProps extends Omit<ContainerProps, "spacing"> {
  axis?: "vertical" | "horizontal" | "both";
  showsIndicators?: boolean;
}

export interface ProgressProps extends CommonProps {
  label?: string;
  value?: number;
}

export interface WindowProps extends Omit<ContainerProps, "spacing"> {
  height?: number;
  resizable?: boolean;
  title?: string;
  width?: number;
}

export interface NativeViewProps extends CommonProps {
  children?: ReactNode;
  name: string;
  props?: Record<string, unknown>;
}

function primitive<Props extends object>(type: string, displayName: string): ComponentType<Props> {
  const Primitive = (props: Props): ReactElement => createElement(type, props);
  Primitive.displayName = displayName;
  return Primitive;
}

export const Window = primitive<WindowProps>("window", "Window");
export const VStack = primitive<VStackProps>("vstack", "VStack");
export const HStack = primitive<HStackProps>("hstack", "HStack");
export const ZStack = primitive<ZStackProps>("zstack", "ZStack");
export const Text = primitive<TextProps>("text", "Text");
export const Button = primitive<ButtonProps>("button", "Button");
export const TextField = primitive<TextFieldProps>("textfield", "TextField");
export const Toggle = primitive<ToggleProps>("toggle", "Toggle");
export const Slider = primitive<SliderProps>("slider", "Slider");
export const Image = primitive<ImageProps>("image", "Image");
export const ScrollView = primitive<ScrollViewProps>("scrollview", "ScrollView");
export const Progress = primitive<ProgressProps>("progress", "Progress");
export const Spacer = primitive<CommonProps>("spacer", "Spacer");
export const Divider = primitive<CommonProps>("divider", "Divider");
export const NativeView = primitive<NativeViewProps>("native", "NativeView");

export type PlatformName = "macos" | "windows";

function currentPlatform(): PlatformName {
  const value = (globalThis as { __NATUI_PLATFORM__?: PlatformName }).__NATUI_PLATFORM__;
  return value ?? "macos";
}

export const Platform = {
  get OS(): PlatformName {
    return currentPlatform();
  },
  select<T>(values: { macos: T; windows: T }): T {
    return values[currentPlatform()];
  },
} as const;

export { Fragment };
