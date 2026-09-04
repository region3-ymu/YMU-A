import { Fragment, type ReactNode } from "react";

// Turns the URLs inside a plain-text body into real links, leaving everything
// else exactly as typed.
//
// News posts are stored and rendered as plain text on purpose (see the
// whitespace-pre-wrap note on the announcement page): managers write them on a
// phone and their line breaks are the only formatting they expect to survive.
// That is still right — but a pasted form link is the whole point of half these
// posts, and a link nobody can tap is a link nobody follows. Two of the four
// posts on the board carry a bare Google Forms URL, 99 and 118 characters long.
//
// React nodes, never dangerouslySetInnerHTML. The body is written by a manager
// and read by everyone signed in; building elements means the text can never
// become markup, whatever somebody types. Only http/https match, so there is no
// javascript: URL to filter out in the first place.
const URL_PATTERN = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

// A URL at the end of a sentence collects the sentence's punctuation, and a URL
// inside brackets collects the bracket. Trailing ) ] } is only dropped when it
// has no opener inside the match, so Wikipedia-style links (…_(band)) survive.
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if (".,;:!?".includes(char)) {
      end -= 1;
      continue;
    }
    const opener = char === ")" ? "(" : char === "]" ? "[" : char === "}" ? "{" : null;
    if (opener) {
      const slice = url.slice(0, end);
      const opens = slice.split(opener).length - 1;
      const closes = slice.split(char).length - 1;
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/**
 * `text` with its URLs as <a> elements. The caller keeps ownership of layout —
 * wrap the result in whatever preserves whitespace and breaks long words
 * (whitespace-pre-wrap break-words), because a 118-character link is also the
 * thing that drags a phone's layout sideways if nothing may break inside it.
 */
export function linkify(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const url = trimTrailingPunctuation(raw);
    // Entirely punctuation after trimming (e.g. "https://" alone): not a link.
    if (!/^(https?:\/\/\S|www\.\S)/i.test(url)) continue;

    if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
    nodes.push(
      <a
        key={`${start}-${url}`}
        href={url.toLowerCase().startsWith("www.") ? `https://${url}` : url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {url}
      </a>,
    );
    lastIndex = start + url.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  // Keys on the plain strings too, so React never warns about the mixed array.
  return nodes.map((node, index) =>
    typeof node === "string" ? <Fragment key={`t-${index}`}>{node}</Fragment> : node,
  );
}
