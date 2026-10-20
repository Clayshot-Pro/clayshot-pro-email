import type { ReactNode } from "react";
import { useAppearance } from "../appearance";

type IconName = "mail" | "inbox" | "junk" | "star" | "send" | "draft" | "archive" | "trash" | "search" | "compose" | "reply" | "forward" | "back" | "refresh" | "paperclip" | "bell" | "lock" | "more" | "menu";

type IconProps = {
  name: IconName;
  size?: number;
};

const paths: Record<IconName, ReactNode> = {
  mail: <><rect x="3.75" y="6.25" width="16.5" height="11.5" rx="2.15"/><path d="M4.85 7.65 12 12.7l7.15-5.05"/></>,
  inbox: <><path d="M4 5.5h16l1.5 9.5v3.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5V15L4 5.5Z"/><path d="M3 15h5l1.5 2h5L16 15h5"/></>,
  junk: <><path d="M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5Z"/><path d="M12 8v5m0 4h.01"/></>,
  star: <path d="m12 3 2.8 5.67 6.2.9-4.5 4.39 1.06 6.2L12 17.24l-5.56 2.92 1.06-6.2L3 9.57l6.2-.9L12 3Z"/>,
  send: <><path d="m21 3-7.2 18-3.3-7.5L3 10.2 21 3Z"/><path d="M10.5 13.5 21 3"/></>,
  draft: <><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h4M8 13h8M8 17h6"/></>,
  archive: <><path d="M4 5h16v4H4z"/><path d="M6 9v10h12V9M9.5 13h5"/></>,
  trash: <><path d="M4 7h16M9 3h6l1 4H8l1-4ZM7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/></>,
  search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
  compose: <><path d="M11.5 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h10a2.5 2.5 0 0 0 2.5-2.5v-4.5"/><path d="M17.3 4.2a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.4.8.8-3.4 7.5-7.7Z"/></>,
  reply: <><path d="m9 8-5 4 5 4"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
  forward: <><path d="m15 8 5 4-5 4"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></>,
  back: <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>,
  refresh: <><path d="M20 7v5h-5"/><path d="M18.2 9A7 7 0 1 0 19 15"/></>,
  paperclip: <path d="m9 12.5 6.8-6.8a3 3 0 1 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7.1-7.1l8.1-8.1"/>,
  bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
};

/** Closed body shapes tinted by the duotone set (open strokes stay as lines). */
const duotoneFill: Partial<Record<IconName, ReactNode>> = {
  mail: <rect x="3.75" y="6.25" width="16.5" height="11.5" rx="2.15"/>,
  inbox: <path d="M4 5.5h16l1.5 9.5v3.5A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5V15L4 5.5Z"/>,
  junk: <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5Z"/>,
  star: <path d="m12 3 2.8 5.67 6.2.9-4.5 4.39 1.06 6.2L12 17.24l-5.56 2.92 1.06-6.2L3 9.57l6.2-.9L12 3Z"/>,
  send: <path d="m21 3-7.2 18-3.3-7.5L3 10.2 21 3Z"/>,
  draft: <path d="M5 3h10l4 4v14H5z"/>,
  archive: <path d="M6 9v10h12V9z"/>,
  trash: <path d="M7 7l1 14h8l1-14z"/>,
  search: <circle cx="11" cy="11" r="6"/>,
  compose: <path d="M17.3 4.2a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.4.8.8-3.4 7.5-7.7Z"/>,
  bell: <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/>,
  lock: <rect x="5" y="10" width="14" height="11" rx="2"/>,
};

export const ICON_SET_LABELS = { ltm: "Outline", "ltm-bold": "Bold outline", duotone: "Duotone" } as const;

export function Icon({ name, size = 18 }: IconProps) {
  const { effective } = useAppearance();
  const set = effective.iconSet;
  const fill = set === "duotone" ? duotoneFill[name] : undefined;
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={set === "ltm" ? "1.8" : "2.3"} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {fill ? <g fill="currentColor" fillOpacity="0.22" stroke="none">{fill}</g> : null}
      {paths[name]}
    </svg>
  );
}

/** Preview of a set for the Appearance picker, independent of the active set. */
export function IconSetPreview({ set }: { set: keyof typeof ICON_SET_LABELS }) {
  return (
    <span className="icon-set-preview" aria-hidden="true">
      {(["inbox", "star", "send", "trash"] as IconName[]).map(name => (
        <svg key={name} className="icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth={set === "ltm" ? "1.8" : "2.3"} strokeLinecap="round" strokeLinejoin="round">
          {set === "duotone" && duotoneFill[name] ? <g fill="currentColor" fillOpacity="0.22" stroke="none">{duotoneFill[name]}</g> : null}
          {paths[name]}
        </svg>
      ))}
    </span>
  );
}
