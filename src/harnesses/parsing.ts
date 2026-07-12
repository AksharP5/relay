type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null;

export const parseJsonLines = (stdout: string): Array<JsonObject> =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return isObject(value) ? [value] : [];
      } catch {
        return [];
      }
    });

export const parseOpenCodeEvent = (
  line: string,
): { readonly sessionId?: string; readonly textPart?: string } => {
  const event = parseJsonLines(line)[0];
  if (!event) return {};
  const sessionId = typeof event.sessionID === "string" ? event.sessionID : undefined;
  const textPart =
    event.type === "text" && isObject(event.part) && typeof event.part.text === "string"
      ? event.part.text
      : undefined;
  return { ...(sessionId ? { sessionId } : {}), ...(textPart !== undefined ? { textPart } : {}) };
};

export const parseCodexOutput = (
  stdout: string,
): { readonly sessionId?: string; readonly text?: string } => {
  const events = parseJsonLines(stdout);
  let sessionId: string | undefined;
  let text: string | undefined;

  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string")
      sessionId = event.thread_id;
    if (event.type !== "item.completed" || !isObject(event.item)) continue;
    if (
      event.item.type === "agent_message" &&
      typeof event.item.text === "string" &&
      event.item.text.trim()
    ) {
      text = event.item.text;
    }
  }

  return { ...(sessionId ? { sessionId } : {}), ...(text ? { text } : {}) };
};

export const parseOpenCodeOutput = (
  stdout: string,
): { readonly sessionId?: string; readonly text?: string } => {
  const events = parseJsonLines(stdout);
  let sessionId: string | undefined;
  const texts: Array<string> = [];

  for (const event of events) {
    sessionId ??= typeof event.sessionID === "string" ? event.sessionID : undefined;
    if (
      event.type === "text" &&
      isObject(event.part) &&
      typeof event.part.text === "string" &&
      event.part.text
    ) {
      texts.push(event.part.text);
    }
  }

  const text = texts.join("").trim();
  return { ...(sessionId ? { sessionId } : {}), ...(text ? { text } : {}) };
};
