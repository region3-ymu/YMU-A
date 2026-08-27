// The bug: a manager attaching "Agosto – Región.png" to an announcement got
// `Invalid key: news/<uid>/…` and no attachment. Supabase Storage validates an
// object key against an S3-safe character set — ASCII \w plus a short list of
// punctuation — and it does so before RLS, so nothing in the migrations could
// have fixed it. Verified against the live API while diagnosing: an accented
// key comes back 400 InvalidKey where the same request with a plain name gets
// as far as the row-level security check.

import { describe, expect, it } from "vitest";
import { storageSafeName } from "../src/lib/news/attachment-name";

// Supabase storage-api's isValidKey, copied rather than imported: it is the
// server's rule, not ours, and a test that shares an implementation with the
// thing it checks proves nothing.
const STORAGE_SAFE = /^(\w|\/|!|-|\.|\*|'|\(|\)| |&|\$|@|=|;|:|\+|,|\?)*$/;

describe("storageSafeName", () => {
  it("leaves an already-safe name alone", () => {
    expect(storageSafeName("YMU_Payment_Schedule.pdf")).toBe("YMU_Payment_Schedule.pdf");
    expect(storageSafeName("IMG_1234.PNG")).toBe("IMG_1234.PNG");
  });

  it("strips accents to the letter underneath rather than to an underscore", () => {
    expect(storageSafeName("Diseño.png")).toBe("Diseno.png");
    expect(storageSafeName("Calendario Agosto – Región 3.png")).toBe(
      "Calendario_Agosto_Region_3.png",
    );
  });

  it("neutralises the characters that corrupt the request URL silently", () => {
    // '#' would make the rest of the path a fragment, '?' a query string —
    // storage-js does not encode the path, so the bytes would land under a
    // truncated name while the row recorded the full one.
    expect(storageSafeName("note#1.png")).toBe("note_1.png");
    expect(storageSafeName("100% cover?.pdf")).toBe("100_cover.pdf");
  });

  it("still produces a usable name when nothing ASCII survives", () => {
    expect(storageSafeName("写真.png")).toBe("attachment.png");
    expect(storageSafeName("🎉")).toBe("attachment");
  });

  it("keeps a name with no extension", () => {
    expect(storageSafeName("Notas de reunión")).toBe("Notas_de_reunion");
  });

  it("bounds the length, keeping the extension", () => {
    const long = `${"á".repeat(300)}.png`;
    const safe = storageSafeName(long);
    expect(safe.length).toBeLessThanOrEqual(93);
    expect(safe.endsWith(".png")).toBe(true);
  });

  it("produces a key Storage will accept, for every name above", () => {
    const names = [
      "YMU_Payment_Schedule.pdf",
      "Diseño.png",
      "Calendario Agosto – Región 3.png",
      "note#1.png",
      "100% cover?.pdf",
      "写真.png",
      "🎉",
      "Notas de reunión",
      "a\\b|c<d>e\"f`g[h]i{j}k~l^m.png",
      `${"á".repeat(300)}.png`,
    ];
    for (const name of names) {
      const key = `9459a851-b590-4de1-9768-2f2c923e343b/1786744087193-${storageSafeName(name)}`;
      expect(STORAGE_SAFE.test(key), `${name} -> ${key}`).toBe(true);
      // An empty final segment would upload to the folder itself.
      expect(key.endsWith("-")).toBe(false);
    }
  });
});
