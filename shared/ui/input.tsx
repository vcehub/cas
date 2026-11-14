import * as React from "react"

import { cn } from "@/shared/lib/utils"

/**
 * Brand-skinned input: a typed blank on a form — hairline underline that
 * sharpens to ink on focus, no box, no ring. Numeric inputs get tabular
 * figures so values don't jitter.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-[36px] max-[768px]:h-[44px] w-full rounded-none border-0 border-b border-hairline bg-transparent px-[2px]",
          "text-bodySm max-[768px]:text-body text-ink placeholder:text-inkMuted tabular-nums",
          "transition-colors duration-fast ease-out",
          "focus-visible:outline-none focus-visible:border-ink",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
