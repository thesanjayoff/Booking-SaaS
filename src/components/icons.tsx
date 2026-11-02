import type { SVGProps } from "react";

/** Inline SVG icons (1.6 stroke, round caps). Decorative by default; pass `title` to label one. */
type IconProps = SVGProps<SVGSVGElement> & { title?: string };

function Svg({ title, children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => <Svg {...p}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></Svg>;
export const ArrowLeft = (p: IconProps) => <Svg {...p}><path d="M19 12H5" /><path d="m11 6-6 6 6 6" /></Svg>;
export const ArrowUpRight = (p: IconProps) => <Svg {...p}><path d="M7 17 17 7" /><path d="M8 7h9v9" /></Svg>;
export const ChevronLeft = (p: IconProps) => <Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>;
export const ChevronRight = (p: IconProps) => <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>;
export const Clock = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const Video = (p: IconProps) => <Svg {...p}><rect x="3" y="6" width="12" height="12" rx="2.5" /><path d="m15 10.5 6-3v9l-6-3" /></Svg>;
export const MapPin = (p: IconProps) => <Svg {...p}><path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></Svg>;
export const Phone = (p: IconProps) => <Svg {...p}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" /></Svg>;
export const Globe = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" /></Svg>;
export const Check = (p: IconProps) => <Svg {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>;
export const Calendar = (p: IconProps) => <Svg {...p}><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17" /><path d="M8 3v4" /><path d="M16 3v4" /></Svg>;
export const Shield = (p: IconProps) => <Svg {...p}><path d="M12 3 5 6v5.5c0 4.2 2.9 7.7 7 9.5 4.1-1.8 7-5.3 7-9.5V6l-7-3Z" /><path d="m9 12 2.2 2.2L15.5 10" /></Svg>;
export const Refresh = (p: IconProps) => <Svg {...p}><path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" /><path d="M20 20v-4h-4" /></Svg>;
export const Alert = (p: IconProps) => <Svg {...p}><path d="M12 3 2.5 19.5h19L12 3Z" /><path d="M12 10v4.5" /><path d="M12 17.5v.01" /></Svg>;
export const Spinner = (p: IconProps) => <Svg {...p} style={{ animation: "spin 0.9s linear infinite", ...p.style }}><path d="M12 3a9 9 0 1 0 9 9" /></Svg>;
export const Download = (p: IconProps) => <Svg {...p}><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></Svg>;
export const Menu = (p: IconProps) => <Svg {...p}><path d="M4 8h16" /><path d="M4 16h16" /></Svg>;
export const Close = (p: IconProps) => <Svg {...p}><path d="M6 6l12 12" /><path d="M18 6 6 18" /></Svg>;
export const ArrowDown = (p: IconProps) => <Svg {...p}><path d="M12 5v14" /><path d="m6 13 6 6 6-6" /></Svg>;
export const Wallet = (p: IconProps) => <Svg {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3" /><rect x="3.5" y="8" width="17" height="11.5" rx="2.5" /><path d="M16.5 13.75h.01" /></Svg>;
export const Lock = (p: IconProps) => <Svg {...p}><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></Svg>;
