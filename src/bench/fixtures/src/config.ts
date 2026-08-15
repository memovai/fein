import { get } from "lodash";

export interface Settings { port: number; host: string }

export function parseConfig(raw: unknown): Settings {
  return { port: get(raw, "port", 3000), host: get(raw, "host", "localhost") };
}
