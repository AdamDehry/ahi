/** Agent presentation for the redesign: FINAL rail order and initials (M, T, Av, Mi, E, Ab). */
export const RAIL_ORDER = ["michael", "tzali", "avi", "miriam"];
const INITIALS: Record<string, string> = { michael: "M", tzali: "T", avi: "Av", miriam: "Mi" };
export const agentInitials = (bot: string) => INITIALS[bot] ?? (bot[0] ?? "?").toUpperCase();
export const railOrder = (bots: string[]) =>
  [...bots].sort((a, b) => (RAIL_ORDER.indexOf(a) + 1 || 99) - (RAIL_ORDER.indexOf(b) + 1 || 99));
