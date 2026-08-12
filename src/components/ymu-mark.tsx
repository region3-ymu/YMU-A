// YMU's Y-M-U letterforms, from the official symbol at ymu.org/branding.
//
// Inlined rather than served as a file, and painted with `currentColor`
// rather than the brand hex. Both choices are about dark mode: the app ships
// light and dark themes, and brand blue on the dark surface is muddy. Taking
// the colour from the surrounding text means the mark is simply legible in
// whichever theme it lands in, with no second asset to keep in step and no
// hidden/dark:block image pair to get wrong.
//
// The full-colour originals are kept in public/brand/ — they are what the icon
// generator builds the launcher icons from, where a fixed background exists
// and the real blue belongs.

export default function YmuMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1055.81 401.52"
      className={className}
      fill="currentColor"
      role="img"
      aria-label="Young Musicians Unite"
    >
      <path d="M324.87,46.91H38.63c-8.08,0-13.25,8.62-9.45,15.75l93.61,174.2c.83,1.55,1.26,3.28,1.26,5.04v102c0,5.91,4.79,10.71,10.71,10.71h94c5.91,0,10.71-4.79,10.71-10.71v-102c0-1.76.43-3.49,1.26-5.04l93.6-174.2c3.8-7.13-1.36-15.75-9.45-15.75Z" />
      <path d="M374.06,57.65v286.25c0,5.91,4.79,10.71,10.71,10.71h286.27c5.91,0,10.71-4.79,10.71-10.71V57.65c0-9.54-11.54-14.32-18.28-7.57l-131.78,149.09c-2.09,2.09-5.48,2.09-7.57,0L392.34,50.07c-6.75-6.75-18.28-1.97-18.28,7.57Z" />
      <path d="M720.21,57.62v143.14c0,84.97,68.88,153.85,153.85,153.85h0c84.97,0,153.85-68.88,153.85-153.85V57.62c0-5.91-4.79-10.71-10.71-10.71h-286.27c-5.91,0-10.71,4.79-10.71,10.71Z" />
    </svg>
  );
}
