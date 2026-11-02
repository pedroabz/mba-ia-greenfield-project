const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

/**
 * The slices of Mailpit's API responses the suites actually read. Typed rather than
 * `any` so a renamed field fails to compile instead of silently asserting against
 * `undefined` — Mailpit capitalises its JSON keys, which is easy to get wrong.
 */
export interface MailpitAddress {
  Address: string;
  Name?: string;
}

/** Summary shape from `GET /api/v1/messages`. */
export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
}

/** Full shape from `GET /api/v1/message/{id}` — carries the rendered bodies. */
export interface MailpitMessage extends MailpitMessageSummary {
  HTML: string;
  Text: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
