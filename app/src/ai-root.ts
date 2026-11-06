import { homedir } from "os";
import { resolve } from "path";

/**
 * The AHI runtime root: agents' souls and memory, mission control, skills, state and logs.
 * AHI Setup points AHI_AI_ROOT at the hidden OS folder of the home it made (<home>/AHI_OS);
 * an existing install keeps ~/ai.
 */
export const AI_ROOT = resolve(process.env.AHI_AI_ROOT || resolve(homedir(), "ai"));
