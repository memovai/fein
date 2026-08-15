import { parseConfig } from "./config.js";

export function start(raw: unknown): string {
  const s = parseConfig(raw);
  return `listening on ${s.host}:${s.port}`;
}
