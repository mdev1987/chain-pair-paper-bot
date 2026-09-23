import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";
import { config } from "./config.ts";

const bot = config.telegram.enabled ? new Bot(config.telegram.token) : null;
const MAX_MESSAGE_CHARS = 3900;

/** Split escaped text into sendable chunks. Exported for unit tests. */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text];

  const chunks: string[] = [];
  let current = "";
  const pushLine = (line: string): void => {
    // A single line longer than the limit (e.g. a full contract address
    // repeated without newlines) must be hard-sliced — otherwise one chunk
    // would exceed Telegram's 4096-char limit and the send would fail.
    let rest = line;
    while (rest.length > MAX_MESSAGE_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(rest.slice(0, MAX_MESSAGE_CHARS));
      rest = rest.slice(MAX_MESSAGE_CHARS);
    }
    const candidate = current ? `${current}\n${rest}` : rest;
    if (candidate.length > MAX_MESSAGE_CHARS && current) {
      chunks.push(current);
      current = rest;
    } else {
      current = candidate;
    }
  };
  for (const line of text.split("\n")) {
    pushLine(line);
  }
  if (current) chunks.push(current);
  return chunks;
}

export async function telegram(markdown: string): Promise<void> {
  if (!bot) return;

  const formatted = convert(markdown, "escape");
  for (const chunk of splitMessage(formatted)) {
    await bot.api.sendMessage(config.telegram.chatId, chunk, {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  }
}

export async function testTelegram(): Promise<void> {
  if (!bot) return;
  await bot.api.getMe();
}
