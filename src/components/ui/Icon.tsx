import React, { forwardRef } from "react";
import { LucideIcon } from "lucide-react";

/** The size a caller gets when it asks for neither a token nor a length. */
export const DEFAULT_ICON_SIZE = 16;

/**
 * How an icon can be sized.
 *
 * - a token (`"xs"`…`"xl"`) maps to the shared scale;
 * - a number is a pixel size;
 * - a CSS length (`"1.5rem"`, `"2em"`) is passed through, so an icon can be sized
 *   *relative* to the type around it;
 * - leaving both `size` and a size class off falls back to `DEFAULT_ICON_SIZE`.
 *
 * A `className` that carries a size (`h-3.5 w-3.5`) is also honoured — see the
 * component below for why that needed fixing.
 */
export type IconSize =
  | "xs"
  | "sm"
  | "md"
  | "lg"
  | "xl"
  | number
  | `${number}${"px" | "rem" | "em"}`;

export const ICON_SIZE_MAP: Record<"xs" | "sm" | "md" | "lg" | "xl", number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
};

/** A token, a pixel count, or a CSS length — whatever the caller asked for. */
export function resolveIconSize(size?: IconSize): number | string {
  if (size === undefined) return DEFAULT_ICON_SIZE;
  if (typeof size === "number") return size;
  if (Object.prototype.hasOwnProperty.call(ICON_SIZE_MAP, size)) {
    return ICON_SIZE_MAP[size as keyof typeof ICON_SIZE_MAP];
  }
  // A CSS length such as "1.5rem": hand it to the browser untouched.
  return size;
}

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "size" | "icon"> {
  icon: LucideIcon;
  size?: IconSize;
  strokeWidth?: number;
  color?: string;
  className?: string;
  title?: string;
}

export const Icon = forwardRef<SVGSVGElement, IconProps>((props, ref) => {
  const { icon: LucideIconComponent, size, strokeWidth = 1.5, color = "currentColor", className = "", title, style, ...rest } = props;
  const explicit = size !== undefined;
  const px = resolveIconSize(size);
  /**
   * `size` is authoritative when the caller passes it; when they do not, the
   * width and height are left to CSS.
   *
   * This is load-bearing. The `width`/`height` *attributes* below are the 16px
   * fallback, because a CSS class beats a presentational attribute — but it does
   * **not** beat an inline style. Writing the resolved size as an inline style
   * unconditionally (as this component used to) meant every `className="h-3.5
   * w-3.5"` in the app silently rendered at the 16px default: one fix here used
   * to change every icon at once, and a per-site size change did nothing at all.
   * Inline now happens only when `size` was actually passed.
   */
  const svgStyle: React.CSSProperties | undefined = explicit
    ? { width: px, height: px, minWidth: px, minHeight: px, ...style }
    : style;
  return (
    <LucideIconComponent
      ref={ref}
      size={px}
      strokeWidth={strokeWidth}
      color={color}
      className={className}
      style={svgStyle}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    />
  );
});
Icon.displayName = "Icon";
