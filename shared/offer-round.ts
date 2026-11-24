import { offerUrl } from './verified-offer';

export type RoundEvidence = { key: string; url: string; locator: string; quote: string };

// A page or date without a written occurrence discriminator is ambiguous.
export function capturedRound(text: string, source: string, locator: string): RoundEvidence | null {
  const lines = text.split('\n').map(line => line.trim());
  const labels = lines.filter(line => /^(?:공구|이벤트|공동구매)\s*(?:회차|행사\s*번호|캠페인\s*ID)\s*[:：]\s*[\p{L}\p{N}._-]{1,80}$/iu.test(line));
  const openings = lines.filter(line => /^(?:공구|공동구매)\s*(?:오픈|시작)\s*[:：]\s*\d{4}[-.]\d{1,2}[-.]\d{1,2}(?:\s+\d{1,2}:\d{2})?$/u.test(line));
  const matches = labels.length ? labels : openings;
  if (matches.length !== 1) return null;
  const quote = matches[0];
  const announcements = lines.flatMap(line => {
    const match = /^(?:공구 공지|공동구매 공지|공구 원문)\s*[:：]\s*(https:\/\/\S+)$/u.exec(line);
    const url = match && offerUrl(match[1]);
    return url ? [url] : [];
  });
  if (announcements.length > 1) return null;
  const url = announcements[0] ?? source;
  const value = quote.split(/[:：]/u).slice(1).join(':').normalize('NFKC').trim().toLowerCase();
  const native = /행사\s*번호|캠페인\s*ID/iu.test(quote);
  return { key: JSON.stringify([native ? 'event' : labels.length ? 'edition':'opening',native ? new URL(url).origin : url,value]), url, locator, quote };
}
