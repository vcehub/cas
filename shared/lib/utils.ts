import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge can't tell a custom font-size name from a custom colour name,
 * so out of the box it drops `text-ui` when `text-inkBody` follows it. The UI
 * steps from tailwind.config.ts are registered here so they survive. Like
 * any font size, each carries a line-height, so a `leading-*` must come after
 * it in cn() or it is dropped. Older
 * names (bodySm, cardLabel, display*) are left unregistered for now: cn()
 * already drops them in places, and registering them would change pixels.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["lead", "ui", "uiSm", "meta"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
