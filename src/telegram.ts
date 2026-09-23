import { Bot } from "grammy";
import { convert } from "telegram-markdown-v2";
import { config } from "./config.ts";

const bot = config.telegram.enabled ? new Bot(config.telegram.token) : null;
const MAX_MESSAGE_CHARS = 3900;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_MESSAGE_CHARS && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
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
