"use client"

import * as React from "react"

import { cn } from "@/shared/lib/utils"
import { Label } from "./label"

/** The wiring a control must carry to be described by its own label line. */
type FieldControl = {
  id: string
  "aria-describedby": string | undefined
  "aria-invalid": true | undefined
}

/** Props a cloned single-element child may already define. */
type ControlAttrs = {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
}

type FieldProps = {
  label: React.ReactNode
  /**
   * Control id. Optional: when absent the field takes the id off its child, or
   * generates one. Either way `htmlFor` and the control agree — that is the
   * point of the component.
   */
  id?: string
  /** Quiet line under the control. Suppressed while `error` is showing. */
  help?: React.ReactNode
  /** Error line under the control. Announced, and marks the control invalid. */
  error?: React.ReactNode
  className?: string
  labelClassName?: string
  /**
   * The control. A single element gets `id` / `aria-describedby` /
   * `aria-invalid` cloned onto it; anything else (a fragment, a control buried
   * in a wrapper) should take the render-prop form and spread them itself.
   */
  children: React.ReactNode | ((control: FieldControl) => React.ReactNode)
}

/**
 * Label + control + one help-or-error line, with the label/control pairing
 * enforced rather than left to whoever writes the JSX: hand-written
 * `htmlFor="x"` / `id="x"` pairs drift, and a mismatched pair is an invisible
 * accessibility bug.
 */
function Field({
  label,
  id,
  help,
  error,
  className,
  labelClassName,
  children,
}: FieldProps) {
  const generatedId = React.useId()
  const element = React.isValidElement<ControlAttrs>(children) ? children : null

  const controlId = id ?? element?.props.id ?? generatedId
  const helpId = help && !error ? `${controlId}-help` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = errorId ?? helpId

  const control: FieldControl = {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  }

  let rendered: React.ReactNode
  if (typeof children === "function") {
    rendered = children(control)
  } else if (element) {
    rendered = React.cloneElement(element, {
      id: controlId,
      // The child's own description survives — both lines matter.
      "aria-describedby":
        [element.props["aria-describedby"], describedBy]
          .filter(Boolean)
          .join(" ") || undefined,
      "aria-invalid": element.props["aria-invalid"] ?? control["aria-invalid"],
    })
  } else {
    rendered = children
  }

  return (
    <div className={cn("flex flex-col gap-[6px]", className)}>
      <Label htmlFor={controlId} className={labelClassName}>
        {label}
      </Label>
      {rendered}
      {error ? (
        <p id={errorId} role="alert" className="m-0 text-bodySm text-signalRed">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="m-0 text-bodySm text-inkMuted">
          {help}
        </p>
      ) : null}
    </div>
  )
}
Field.displayName = "Field"

export { Field }
export type { FieldControl, FieldProps }
