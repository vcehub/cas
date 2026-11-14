import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/shared/lib/utils"

type SelectProps = React.ComponentProps<"select"> & {
  /** Classes for the positioning wrapper, not the control itself. */
  wrapperClassName?: string
}

/**
 * Brand-skinned select: a typed-blank underline, so a select and a text field
 * sitting in one column share a baseline. The rule is 1.5px stone rather than
 * a hairline — a hairline under a control reads as decoration, not as a blank
 * asking to be filled. `appearance-none` strips the platform arrow, so the
 * chevron is drawn back over the right edge — without it the control reads as
 * a disabled input.
 *
 * Native in every other respect: `<option>` / `<optgroup>` pass straight
 * through as children and every select prop is forwarded.
 */
const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, children, ...props }, ref) => {
    return (
      <div className={cn("relative w-full", wrapperClassName)}>
        <select
          className={cn(
            "peer flex h-[36px] max-[768px]:h-[44px] w-full appearance-none rounded-none border-0 border-b-[1.5px] border-borderStrong bg-transparent",
            // Right padding clears the chevron so long option labels don't
            // run under it.
            "pl-[2px] pr-[24px]",
            "text-bodySm max-[768px]:text-body text-ink",
            "transition-colors duration-fast ease-out",
            "focus-visible:outline-none focus-visible:border-ink",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          ref={ref}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-[2px] top-1/2 h-[16px] w-[16px] -translate-y-1/2 text-inkMuted peer-disabled:opacity-50"
        />
      </div>
    )
  }
)
Select.displayName = "Select"

export { Select }
