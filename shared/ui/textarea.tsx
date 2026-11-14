import * as React from "react"

import { cn } from "@/shared/lib/utils"

/**
 * Brand-skinned textarea: a page to write on rather than a blank to fill, so
 * unlike `Input` it is a filled surface — white paper inside a hairline, the
 * prompt field from the essay board. Keeps the global focus ring; the border
 * darkening to ink is the second cue, not the only one.
 */
const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        "w-full min-h-[92px] rounded-card border border-hairline bg-white px-[14px] py-[12px]",
        "text-bodySm max-[768px]:text-body leading-[1.55] text-ink placeholder:text-inkMuted",
        "transition-colors duration-fast ease-out",
        "focus-visible:border-ink",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
