/* Redesign icon set — the FINAL prototype's glyph paths (rendered DOM, v26),
   24×24, 1.6 stroke. Brand marks (Gmail, WhatsApp Business) are the accepted
   local assets in /brand (see specifications/BRAND-ASSETS.md). */
const P: Record<string, string> = {
  home: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  today: "M8 2.5v4m8-4v4M3 9.5h18M6 4.5h12a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3ZM8.5 13h7M12 13v5",
  calendar: "M8 2.5v4m8-4v4M3 10h18M6 4.5h12a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-11a3 3 0 0 1 3-3ZM8 13.5h.01M12 13.5h.01M16 13.5h.01M8 17.5h.01M12 17.5h.01",
  messages: "M7 4h10a4 4 0 0 1 4 4v12l-4-3H7a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4ZM8 10.5h.01M12 10.5h.01M16 10.5h.01",
  layers: "m12 4 9 4.5-9 4.5-9-4.5L12 4ZM3 12.5 12 17l9-4.5M3 16.5 12 21l9-4.5",
  folder: "M3 5h6l2 3h10v12H3Z",
  inbox: "M5 3h14l3 12v5H2v-5L5 3ZM2 15h6l2 3h4l2-3h6",
  star: "m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3L12 17.4l-5.6 3 1.1-6.3L3 9.6l6.2-.9L12 3Z",
  edit: "m15 4 5 5M4 15 16 3l5 5L9 20l-6 1 1-6Z",
  archive: "M3 4h18v5H3ZM5 9v12h14V9M10 13h4",
  spam: "m8 3-5 5v8l5 5h8l5-5V8l-5-5H8ZM12 7v6m0 4h.01",
  trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
  refresh: "M20 9a8 8 0 0 0-14-5L3 7m0-5v5h5M4 15a8 8 0 0 0 14 5l3-3m0 5v-5h-5",
  reply: "m10 5-7 6 7 6v-5c7 0 10 3 11 7 0-8-4-12-11-12V5Z",
  forward: "m14 5 7 6-7 6v-5c-7 0-10 3-11 7 0-8 4-12 11-12V5Z",
  paperclip: "m8 12 6-6a3 3 0 0 1 4 4L9 19a5 5 0 0 1-7-7L13 1m-6 14 8-8",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm-1 1 9 7 9-7",
  download: "M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4",
  file: "M6 3h8l4 4v14H6ZM14 3v4h4M9 12h6M9 16h6",
  wallet: "M4 5h15v4H4a2 2 0 0 1 0-4Zm0 4v11h17V9Zm11 5h6",
  shield: "m12 2 8 3v7c0 5-8 10-8 10S4 17 4 12V5Zm-4 10 3 3 5-6",
  people: "M16 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3M17 4a4 4 0 0 1 0 8M21 21v-3a4 4 0 0 0-3-3.8M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  plug: "M9 3v5m6-5v5M7 8h10v4a5 5 0 0 1-5 5v4M7 8v4a5 5 0 0 0 5 5",
  chevrons: "m8 8 4-4 4 4m-8 8 4 4 4-4",
  phone: "M6 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-2a1 1 0 0 0-.7-1l-3.6-1.2a1 1 0 0 0-1 .2L14 18a16 16 0 0 1-8-8l2-1.7a1 1 0 0 0 .2-1L7 3.7A1 1 0 0 0 6 3Z",
  chevron: "m8 10 4 4 4-4",
  "chevron-right": "m9 5 7 7-7 7",
  search: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z",
  bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 4h4",
  sun: "M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.64 5.64l1.06 1.06M17.3 17.3l1.06 1.06M5.64 18.36l1.06-1.06M17.3 6.7l1.06-1.06",
  moon: "M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13",
  menu: "M4 6h16M4 12h16M4 18h16",
  "arrow-left": "M20 12H4m6-6-6 6 6 6",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
  "arrow-up": "M12 20V4m-6 6 6-6 6 6",
  x: "m6 6 12 12M6 18 18 6",
  plus: "M12 5v14M5 12h14",
  wave: "M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4",
  spark: "m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z",
  pulse: "M2 12h4l3-8 5 16 3-8h5",
  check: "m5 12 4 4L19 6",
  upload: "M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5",
  panel: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm5 0v14",
  monitor: "M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 15h8m-4-4v4",
  image: "M4 5h16v14H4ZM4 15l4-4 4 4 3-3 5 5M15.5 9.5h.01",
  // Walkthrough gaps G/H (ONE-FOR-ONE.md): Settings nav Passkeys / Account and the Finances row link, FINAL paths.
  fingerprint: "M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .131-5.354 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2M8.65 22c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2",
  settings: "M9 3h6l1 4 4 1v8l-4 1-1 4H9l-1-4-4-1V8l4-1 1-4ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  exit: "M10 3H3v18h7M8 12h13m-5-5 5 5-5 5",
  link: "m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M13 17a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-2 2",
};

export type IconName = keyof typeof P | "gmail" | "whatsapp-business";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  if (name === "gmail" || name === "whatsapp-business")
    return <img className={`rd-brand-icon${className ? ` ${className}` : ""}`} src={`/brand/${name}.svg`} alt="" aria-hidden="true" />;
  return (
    <svg className={`rd-icon${className ? ` ${className}` : ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={P[name] ?? P.spark} />
    </svg>
  );
}
