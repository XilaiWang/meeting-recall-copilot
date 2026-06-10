// Shared UI class conventions so a11y treatment stays consistent across surfaces.
// Append these to a button/input className (template literal) rather than re-deriving.

// High-contrast keyboard focus ring for elements on light backgrounds (WCAG AA).
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-1';

// Focus ring for elements on dark/translucent backgrounds (e.g. the float window).
export const FOCUS_RING_LIGHT =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70';

// Disabled treatment — opacity-40 failed contrast; 60 + not-allowed reads clearly.
export const DISABLED = 'disabled:opacity-60 disabled:cursor-not-allowed';
