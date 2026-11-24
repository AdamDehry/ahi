/**
 * Every area's strings, merged. Each area file owns the keys prefixed with its
 * name ("chat.*" lives in chat.ts) and types its Hebrew as
 * Record<keyof typeof en, string>, so a key with no translation does not compile.
 */
import * as builds from "./builds";
import * as calendar from "./calendar";
import * as chat from "./chat";
import * as common from "./common";
import * as connections from "./connections";
import * as files from "./files";
import * as gmail from "./gmail";
import * as home from "./home";
import * as lang from "./lang";
import * as login from "./login";
import * as media from "./media";
import * as money from "./money";
import * as ops from "./ops";
import * as settings from "./settings";
import * as shell from "./shell";
import * as vault from "./vault";
import * as voice from "./voice";

/** Area name → its catalogs (the tests walk this). */
export const AREAS = { builds, calendar, chat, common, connections, files, gmail, home, lang, login, media, money, ops, settings, shell, vault, voice };

export const EN = {
  ...builds.en, ...calendar.en, ...chat.en, ...common.en, ...connections.en, ...files.en, ...gmail.en, ...home.en,
  ...lang.en, ...login.en, ...media.en, ...money.en, ...ops.en, ...settings.en, ...shell.en, ...vault.en, ...voice.en,
};
export type Key = keyof typeof EN;

export const HE: Record<Key, string> = {
  ...builds.he, ...calendar.he, ...chat.he, ...common.he, ...connections.he, ...files.he, ...gmail.he, ...home.he,
  ...lang.he, ...login.he, ...media.he, ...money.he, ...ops.he, ...settings.he, ...shell.he, ...vault.he, ...voice.he,
};

export const CATALOGS: Record<"en" | "he", Record<Key, string>> = { en: EN, he: HE };
