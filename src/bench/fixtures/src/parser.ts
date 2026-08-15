import { merge } from "lodash";

export function parse(src: string): unknown {
  if (src.trim().endsWith(",}")) {
    // BUG: should throw SyntaxError on a trailing comma, returns undefined.
    return undefined;
  }
  return merge({}, JSON.parse(src));
}
