/**
 * Read an error response body with a byte cap and a wall-clock deadline.
 *
 * A bare `res.text()` on an error path is unbounded twice over: a server can
 * declare or stream an arbitrarily large body, and it can open the body then
 * stall forever. Both are realistic against a broken proxy or a provider having
 * a bad day, and neither is worth guarding against with a timeout on the
 * *request* — the request already succeeded, it just returned a non-OK status.
 *
 * The body is only ever shown truncated in an error message, so reading
 * megabytes buys nothing and blocking forever costs everything.
 */
export async function readErrorBody(res: Response, maxBytes = 4096, timeoutMs = 5000): Promise<string> {
  try {
    const text = await Promise.race([
      res.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve("(error body read timed out)"), timeoutMs)),
    ]);
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}… (truncated)` : text;
  } catch {
    return "(error body unavailable)";
  }
}
