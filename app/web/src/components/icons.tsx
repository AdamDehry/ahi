// Minimal geometric icon set — 16px stroke icons, currentColor.
// Deliberately quiet: the design's chrome glyphs are line drawings.

function Svg({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconSidebar = () => (
  <Svg>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <line x1="6" y1="2.5" x2="6" y2="13.5" />
  </Svg>
);

export const IconMenu = () => (
  <Svg>
    <circle cx="8" cy="3.2" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="12.8" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconGear = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.9M8 12.3v1.9M1.8 8h1.9M12.3 8h1.9M3.6 3.6l1.35 1.35M11.05 11.05l1.35 1.35M12.4 3.6l-1.35 1.35M4.95 11.05L3.6 12.4" />
  </Svg>
);

export const IconMessages = () => (
  <Svg>
    <path d="M14 7.5c0 2.9-2.7 5.2-6 5.2-.8 0-1.6-.13-2.3-.37L2 13.5l1-2.6C2.4 10 2 8.8 2 7.5 2 4.6 4.7 2.3 8 2.3s6 2.3 6 5.2z" />
  </Svg>
);

export const IconGrid = () => (
  <Svg>
    <rect x="2" y="2" width="5" height="5" rx="1.2" />
    <rect x="9" y="2" width="5" height="5" rx="1.2" />
    <rect x="2" y="9" width="5" height="5" rx="1.2" />
    <rect x="9" y="9" width="5" height="5" rx="1.2" />
  </Svg>
);

export const IconClipboard = () => (
  <Svg>
    <rect x="3" y="3" width="10" height="11" rx="1.5" />
    <rect x="5.5" y="1.5" width="5" height="3" rx="1" />
  </Svg>
);

export const IconFiles = () => (
  <Svg>
    <path d="M3 2.5h5l1.5 2H13a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
  </Svg>
);

export const IconCosts = () => (
  <Svg>
    <line x1="8" y1="1.5" x2="8" y2="14.5" />
    <path d="M11 4.2c-.6-.9-1.7-1.4-3-1.4-1.8 0-3 .9-3 2.3 0 3 6 1.7 6 4.7 0 1.4-1.2 2.3-3 2.3-1.4 0-2.6-.6-3.2-1.6" />
  </Svg>
);

export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.2" />
    <line x1="10.2" y1="10.2" x2="13.8" y2="13.8" />
  </Svg>
);

export const IconBack = () => (
  <Svg>
    <path d="M10 2.5 4.5 8 10 13.5" />
  </Svg>
);

export const IconClose = () => (
  <Svg>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Svg>
);

export const IconHamburger = () => (
  <Svg>
    <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
    <line x1="2.5" y1="8" x2="13.5" y2="8" />
    <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
  </Svg>
);

export const IconSend = () => (
  <Svg size={18}>
    <path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" />
  </Svg>
);

export const IconMic = () => (
  <Svg size={18}>
    <rect x="6" y="1.8" width="4" height="7.5" rx="2" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.2" />
  </Svg>
);

export const IconPlus = () => (
  <Svg size={18}>
    <line x1="8" y1="3" x2="8" y2="13" />
    <line x1="3" y1="8" x2="13" y2="8" />
  </Svg>
);

export const IconChevronDown = () => (
  <Svg>
    <polyline points="4,6.5 8,10.5 12,6.5" />
  </Svg>
);

export const IconCopy = () => (
  <Svg>
    <rect x="5" y="5" width="9" height="9" rx="1.5" />
    <path d="M3.5 10.5H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5" />
  </Svg>
);

export const IconTrash = () => (
  <Svg>
    <path d="M2.5 4h11M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M4 4l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4" />
  </Svg>
);

export const IconDownload = () => (
  <Svg>
    <path d="M8 2v8M4.5 7 8 10.5 11.5 7M2.5 13.5h11" />
  </Svg>
);

export const IconPlay = () => (
  <Svg size={13}>
    {/* 13px per showcase v2 voice frames */}
    <path d="M4 2.8v10.4L13 8z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = () => (
  <Svg size={14}>
    <rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" stroke="none" />
    <rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

/** External-link: open-in-new-tab square with arrow (Costs "manage"). */
export const IconManage = () => (
  <Svg>
    <path d="M12.5 9v3.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H7" />
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
  </Svg>
);

/* ── Review desk ─────────────────────────────────────────────────────── */

/** Review — a tray with a check: things waiting for a yes. */
export const IconReview = () => (
  <Svg>
    <path d="M1.8 9.2l1.6-5.6a1.3 1.3 0 0 1 1.25-.95h6.7a1.3 1.3 0 0 1 1.25.95l1.6 5.6" />
    <path d="M1.8 9.2v3.3a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V9.2H10.6a2.6 2.6 0 0 1-5.2 0z" />
    <path d="M6.2 6.1l1.3 1.3 2.4-2.6" />
  </Svg>
);

/** Fingerprint — the RED lane's mark. Concentric arcs, no fill. */
export const IconFingerprint = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4.1 3.4A5.6 5.6 0 0 1 13.4 7.6" />
    <path d="M2.6 6.2A5.6 5.6 0 0 0 2.4 8.4" />
    <path d="M5.2 13.4a9 9 0 0 1-.9-4.4 3.7 3.7 0 0 1 7.4-.1c0 .9-.1 1.8-.3 2.6" />
    <path d="M8 8.6c.1 2-.3 3.8-1 5.2" />
    <path d="M10.2 13.6c.4-.8.6-1.7.7-2.6" />
    <path d="M13.4 10.2c0 .5-.1 1-.2 1.5" />
  </Svg>
);

export const IconLock = () => (
  <Svg>
    <rect x="3" y="7" width="10" height="7" rx="1.6" />
    <path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7" />
  </Svg>
);

export const IconCheck = () => (
  <Svg>
    <path d="M3 8.4l3.1 3.1L13 4.6" />
  </Svg>
);

/** Tracks — three lanes, one moving. */
export const IconTracks = () => (
  <Svg>
    <path d="M2 4h12M2 8h12M2 12h12" opacity="0.45" />
    <circle cx="5" cy="4" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="10.5" cy="8" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Svg>
);

/** Answer — a speech bubble: "Answer in thread" / "Ask Michael". */
export const IconAnswer = () => (
  <Svg size={18}>
    <path d="M2.5 3.5h11v7H6.2L2.5 13.4z" />
  </Svg>
);

/**
 * WhatsApp dashboard — the official brand mark in full colour: WhatsApp green
 * bubble, white handset, transparent ground. Fills are fixed, not currentColor, so it stays
 * green in light, dark and on the active (brass) row. Geometry is simple-icons "whatsapp"
 * (CC0); the padded viewBox brings it to the ~13px optical size of the 16px stroke icons.
 */
export const IconWhatsApp = () => (
  <svg width={16} height={16} viewBox="-3 -3 30 30" aria-hidden="true">
    <path fill="#25D366" d="M20.464 3.488A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    <path fill="#FFFFFF" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347Z" />
  </svg>
);

/** Call back — a handset. */
export const IconPhone = () => (
  <Svg size={18}>
    <path d="M4.3 2.3h2l1 2.7-1.3.9a6.7 6.7 0 0 0 4.1 4.1l.9-1.3 2.7 1v2a1.3 1.3 0 0 1-1.5 1.3A10.7 10.7 0 0 1 3 3.8a1.3 1.3 0 0 1 1.3-1.5z" />
  </Svg>
);

/** Media panel: a framed picture — the chat's media, files, links. */
export const IconMedia = () => (
  <Svg>
    <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
    <circle cx="5.6" cy="6.2" r="1.2" />
    <path d="M2.2 12.2 6.4 8.6l2.6 2.2 2.2-1.8 2.6 2.2" />
  </Svg>
);

/** "Show in chat": a speech bubble with an arrow back into it. */
export const IconShowInChat = () => (
  <Svg>
    <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    <path d="M6 7h4M8.4 5.4 10 7 8.4 8.6" />
  </Svg>
);

export const IconLink = () => (
  <Svg>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
  </Svg>
);

/** Feed (start-button-feed): three stacked rows, the top one with a play mark. */
export const IconFeed = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5h8M3 9h12M3 13.5h12" />
    <path d="M13.5 3l2.5 1.5-2.5 1.5z" fill="currentColor" stroke="none" />
  </svg>
);
