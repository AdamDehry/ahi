/**
 * This install's own public address: AHI_APP_URL, set by AHI Setup when you add a private address
 * (Access anywhere), else the local app. Links in messages, the phone line's webhook and passkeys use it.
 */
export const APP_URL = (process.env.AHI_APP_URL || `http://localhost:${process.env.GATEWAY_PORT || 18789}`).replace(/\/$/, "");
export const APP_HOST = new URL(APP_URL).hostname.toLowerCase();
