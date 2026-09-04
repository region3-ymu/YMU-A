// linkify() turns a manager's typed announcement into nodes, and the one thing
// that must never happen is text becoming markup. These assert the boundaries
// rather than the markup: which substrings became links, and what href each one
// points at.

import { describe, expect, it } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { linkify } from "../src/lib/format/linkify";

/** The href of every <a> the result contains, in order. */
function hrefs(nodes: ReactNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (isValidElement(node) && node.type === "a") {
      out.push((node.props as { href: string }).href);
    }
  }
  return out;
}

/** The visible text of every <a>, in order. */
function linkTexts(nodes: ReactNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (isValidElement(node) && node.type === "a") {
      out.push((node.props as { children: string }).children);
    }
  }
  return out;
}

describe("linkify", () => {
  it("leaves a post with no link untouched", () => {
    const nodes = linkify("Payment schedule is the 15th and the 30th.");
    expect(hrefs(nodes)).toEqual([]);
  });

  // The two real posts on the board, both bare Google Forms URLs.
  it("links the real posts' form URLs", () => {
    const shows = linkify(
      "Report every performance here: https://docs.google.com/forms/d/e/1FAIpQLSfWFJg_v7CpVZudmbnHMc1OAotJReKvu53UooCwoB6unl8bSw/viewform",
    );
    expect(hrefs(shows)).toEqual([
      "https://docs.google.com/forms/d/e/1FAIpQLSfWFJg_v7CpVZudmbnHMc1OAotJReKvu53UooCwoB6unl8bSw/viewform",
    ]);

    const mentorship = linkify(
      "Sign up: https://docs.google.com/forms/d/e/1FAIpQLSc4CWTTXunRXBFPB664jZ-LiZKUjJwzZvCKRowvVhDw2iyoJA/viewform?usp=publish-editor",
    );
    expect(hrefs(mentorship)).toEqual([
      "https://docs.google.com/forms/d/e/1FAIpQLSc4CWTTXunRXBFPB664jZ-LiZKUjJwzZvCKRowvVhDw2iyoJA/viewform?usp=publish-editor",
    ]);
  });

  it("finds several links in one post", () => {
    const nodes = linkify("Form: https://a.example/one and the guide http://b.example/two thanks");
    expect(hrefs(nodes)).toEqual(["https://a.example/one", "http://b.example/two"]);
  });

  // A manager typing on a phone ends the sentence right after pasting.
  it("does not swallow the sentence's punctuation", () => {
    expect(linkTexts(linkify("Fill this in: https://example.com/form."))).toEqual([
      "https://example.com/form",
    ]);
    expect(linkTexts(linkify("Use https://example.com/form, then tell your RM."))).toEqual([
      "https://example.com/form",
    ]);
  });

  it("keeps a bracket the URL actually opened", () => {
    expect(linkTexts(linkify("See https://example.com/a_(b) for details"))).toEqual([
      "https://example.com/a_(b)",
    ]);
    expect(linkTexts(linkify("(see https://example.com/a)"))).toEqual(["https://example.com/a"]);
  });

  it("gives a www. link a real scheme", () => {
    const nodes = linkify("Try www.ymu.org for the roster");
    expect(linkTexts(nodes)).toEqual(["www.ymu.org"]);
    expect(hrefs(nodes)).toEqual(["https://www.ymu.org"]);
  });

  // The whole reason this builds React nodes instead of an HTML string.
  it("never turns typed text into markup or a script URL", () => {
    const nodes = linkify('<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,<b>');
    expect(hrefs(nodes)).toEqual([]);
    // Everything came back as plain strings/fragments, nothing became an <a>.
    expect(nodes.every((node) => !(isValidElement(node) && node.type === "a"))).toBe(true);
  });

  it("ignores a scheme with nothing after it", () => {
    expect(hrefs(linkify("the protocol https:// on its own"))).toEqual([]);
  });
});
