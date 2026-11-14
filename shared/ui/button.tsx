import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import Link from "next/link";
import { cn } from "@/shared/lib/utils";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost";
type ButtonSize = "md" | "lg";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "ref"> & {
  arrow?: boolean;
  href?: string;
  /**
   * With `href`, render a plain `<a>` instead of Next's `<Link>`: for a route
   * handler such as a download, which `<Link>` would prefetch on sight.
   */
  plain?: boolean;
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  /** Filled and outline variants only. `lg` is the landing's 52px CTA. */
  size?: ButtonSize;
  children: ReactNode;
};

/**
 * `ghost` is the historical Button: a text-and-arrow affordance whose arrow
 * slides on hover. It stays the default so the ~15 existing call sites render
 * exactly the class string they always have — do not touch this array without
 * re-checking them.
 */
const STYLES = [
  "group inline-flex items-center gap-[6px] hover:gap-[10px] whitespace-nowrap",
  "text-bodySm font-medium text-ink",
  "transition-[gap,color] duration-fast ease-out",
  "hover:text-accent",
];

/**
 * The filled variants. Both are 44px tall (the mobile touch-target floor) and
 * share the control geometry; only the fill differs. `primary` is the one lit
 * thing on the screen — the accent budget means at most one per viewport.
 * `secondary` is the same shape in stone, for the second-choice path
 * (e.g. "Continue with Google" next to "Create your account").
 *
 * The keyboard ring comes from the global `:focus-visible` baseline in
 * globals.css — nothing here sets `outline-none`.
 */
const CONTROL_STYLES = [
  "inline-flex items-center justify-center gap-[8px] whitespace-nowrap",
  "min-h-[44px] px-6 rounded-card",
  // 15px — the control step on the canvas. An arbitrary length because, until
  // the UI steps were registered in shared/lib/utils.ts, `cn` dropped a named
  // size beside a colour. `text-ui` would now survive, but it also sets a
  // line-height, so the length stays. (The trap still eats `text-bodySm` in
  // the ghost variant.)
  "text-[15px]",
  "transition-colors duration-fast ease-out",
  // A hair of tracking on a filled control. Sans set solid at a heavier
  // weight tightens optically; 0.01em gives the letters back the air they
  // lose and stops the label reading as a default-template button.
  "tracking-[0.01em]",
  "disabled:opacity-50 disabled:cursor-not-allowed",
];

/**
 * `outline` is the quiet control for a toolbar or a secondary path where a
 * stone fill would read as selected — "Subscribe", "Upload a timetable",
 * "Refresh". A 1px `borderStrong` edge (3:1 on cream), no fill at rest.
 */
const VARIANT_STYLES: Record<ButtonVariant, string[]> = {
  ghost: STYLES,
  primary: [...CONTROL_STYLES, "font-semibold bg-accent text-accentOn hover:bg-accentPressed"],
  secondary: [...CONTROL_STYLES, "font-medium bg-surface text-ink hover:bg-surfaceHover"],
  outline: [...CONTROL_STYLES, "font-medium border border-borderStrong bg-transparent text-ink hover:bg-surface"],
};

/** The landing's CTA size: hero, pricing card, closing band. */
const LARGE = "min-h-[52px] px-[30px] text-[16px]";

export function Button({
  arrow,
  href,
  plain = false,
  variant = "ghost",
  size = "md",
  children,
  className,
  ref,
  ...rest
}: ButtonProps) {
  // The arrow is the ghost variant's whole affordance, so it stays on by
  // default there. Filled controls read as buttons already — they only get an
  // arrow when a caller asks for one.
  const showArrow = arrow ?? variant === "ghost";
  const klass = cn(
    ...VARIANT_STYLES[variant],
    size === "lg" && variant !== "ghost" && LARGE,
    className,
  );
  const inner = (
    <>
      {children}
      {showArrow ? <span aria-hidden="true">→</span> : null}
    </>
  );

  if (href && plain) {
    return (
      <a href={href} className={klass} {...(rest as AnchorHTMLAttributes<HTMLAnchorElement>)}>
        {inner}
      </a>
    );
  }

  if (href) {
    return (
      <Link href={href} className={klass}>
        {inner}
      </Link>
    );
  }

  return (
    <button ref={ref} className={klass} {...rest}>
      {inner}
    </button>
  );
}
