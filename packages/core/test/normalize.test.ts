import { describe, expect, it } from "vitest";
import {
  cleanText,
  extractVolume,
  hasMixedScripts,
  nameKey,
  normalizeAsin,
  normalizeIsbn,
  parseDate,
  parseLink,
  slugify,
  titleKey,
  trigramSimilarity,
} from "../src/catalog/normalize";

describe("text", () => {
  it("cleans display text", () => {
    expect(cleanText("  He​Who  Fights with “Monsters” \u0007")).toBe('HeWho Fights with "Monsters"');
    expect(cleanText("Ｆｕｌｌｗｉｄｔｈ")).toBe("Fullwidth");
    expect(cleanText("It’s")).toBe("It's");
  });

  it("builds name keys that survive punctuation, accents and initials", () => {
    expect(nameKey("J. R. R. Tolkien")).toBe("jrr tolkien");
    expect(nameKey("J.R.R. Tolkien")).toBe("jrr tolkien");
    expect(nameKey("JRR Tolkien")).toBe("jrr tolkien");
    expect(nameKey("Shirtaloon")).toBe("shirtaloon");
    expect(nameKey("  Andrew  Rowe ")).toBe("andrew rowe");
    expect(nameKey("José Núñez")).toBe("jose nunez");
    expect(nameKey("Matt Dinniman & Friends")).toBe("matt dinniman and friends");
  });

  it("flags mixed-script homoglyph spoofs", () => {
    expect(hasMixedScripts("Cradle")).toBe(false);
    expect(hasMixedScripts("Сradle")).toBe(true); // Cyrillic С
    expect(hasMixedScripts("Путь Cradle")).toBe(false); // separate words are fine
  });

  it("slugs", () => {
    expect(slugify("He Who Fights With Monsters 2: A LitRPG Adventure")).toBe(
      "he-who-fights-with-monsters-2-a-litrpg-adventure",
    );
    expect(slugify("Beware of Chicken")).toBe("beware-of-chicken");
    expect(slugify("José's Café & Dungeon")).toBe("joses-cafe-and-dungeon");
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify(`${"a".repeat(30)} ${"b".repeat(60)}`).length).toBeLessThanOrEqual(80);
  });
});

describe("title keys", () => {
  it("strips retailer series tags and marketing subtitles", () => {
    expect(titleKey("The Primal Hunter: A LitRPG Adventure (The Primal Hunter Book 1)")).toBe(
      "primal hunter",
    );
    expect(titleKey("Unsouled (Cradle Book 1)")).toBe("unsouled");
    expect(titleKey("Azarinth Healer: A LitRPG Fantasy")).toBe("azarinth healer");
    expect(titleKey("Beware of Chicken - A Xianxia Cultivation Novel")).toBe("beware of chicken");
    expect(titleKey("Dungeon Crawler Carl [A LitRPG Adventure]")).toBe("dungeon crawler carl");
  });

  it("keeps volume numbers that tell siblings apart", () => {
    expect(titleKey("The Primal Hunter 2: A LitRPG Adventure (The Primal Hunter Book 2)")).toBe(
      "primal hunter 2",
    );
    expect(titleKey("The Wandering Inn: Volume 1")).toBe("wandering inn volume 1");
    expect(titleKey("Mother of Learning: Arc 1")).toBe("mother of learning arc 1");
    expect(titleKey("Defiance of the Fall 10")).not.toBe(titleKey("Defiance of the Fall"));
  });

  it("keeps real subtitles", () => {
    expect(titleKey("The Land: Founding")).toBe("land founding");
    expect(titleKey("Cradle: Blackflame")).toBe("cradle blackflame");
  });

  it("extracts volume numbers", () => {
    expect(extractVolume("Unsouled (Cradle Book 1)")).toBe(1);
    expect(extractVolume("The Primal Hunter 2: A LitRPG Adventure")).toBe(2);
    expect(extractVolume("The Wandering Inn: Volume 3")).toBe(3);
    expect(extractVolume("Book Four")).toBe(4);
    expect(extractVolume("Dungeon Crawler Carl #5")).toBe(5);
    expect(extractVolume("Stray Cat Strut (Dungeon Crawler Carl Book 8)")).toBe(8);
    expect(extractVolume("Book of the Dead")).toBeNull();
    expect(extractVolume("Unsouled")).toBeNull();
    expect(extractVolume("Book 2.5: The Side Story")).toBe(2.5);
  });

  it("similarity", () => {
    expect(trigramSimilarity("primal hunter", "primal hunter")).toBe(1);
    expect(trigramSimilarity("primal hunter", "primal huntr")).toBeGreaterThan(0.6);
    expect(trigramSimilarity("primal hunter", "cradle")).toBeLessThan(0.1);
  });
});

describe("identifiers", () => {
  it("validates and converts ISBNs", () => {
    expect(normalizeIsbn("978-1-949890-35-8")).toBe("9781949890358");
    expect(normalizeIsbn("0-306-40615-2")).toBe("9780306406157");
    expect(normalizeIsbn("0306406152")).toBe("9780306406157");
    expect(normalizeIsbn("9781949890359")).toBeNull(); // bad checksum
    expect(normalizeIsbn("12345")).toBeNull();
    expect(normalizeIsbn(null)).toBeNull();
  });

  it("validates ASINs", () => {
    expect(normalizeAsin(" b07xyz1234 ")).toBe("B07XYZ1234");
    expect(normalizeAsin("0306406152")).toBeNull();
    expect(normalizeAsin("B07")).toBeNull();
  });
});

describe("links", () => {
  it("canonicalizes Amazon links and pulls the ASIN", () => {
    const r = parseLink(
      "https://www.amazon.com/Primal-Hunter-LitRPG-Adventure-ebook/dp/B09JZ4XYZ1/ref=sr_1_1?crid=ABC&keywords=primal&qid=1&sr=8-1&tag=someone-20",
    );
    expect(r).toEqual({
      ok: true,
      link: { kind: "amazon", url: "https://www.amazon.com/dp/B09JZ4XYZ1", region: "US", asin: "B09JZ4XYZ1" },
    });
    const uk = parseLink("https://amazon.co.uk/gp/product/B09JZ4XYZ1?psc=1");
    expect(uk.ok && uk.link.region).toBe("GB");
  });

  it("handles Audible, Royal Road and other platforms", () => {
    const a = parseLink(
      "https://www.audible.com/pd/The-Primal-Hunter-Audiobook/B0B1234567?qid=1&ref=a_search",
    );
    expect(a.ok && a.link).toMatchObject({
      kind: "audible",
      asin: "B0B1234567",
      url: "https://www.audible.com/pd/B0B1234567",
    });
    const rr = parseLink("https://www.royalroad.com/fiction/36049/the-primal-hunter?utm_source=x");
    expect(rr.ok && rr.link).toMatchObject({
      kind: "royalroad",
      royalRoadId: "36049",
      url: "https://www.royalroad.com/fiction/36049",
    });
    expect(parseLink("https://www.kobo.com/us/en/ebook/cradle").ok).toBe(true);
    const other = parseLink("https://example-author.com/books?utm_campaign=x#top");
    expect(other.ok && other.link).toEqual({
      kind: "other",
      url: "https://example-author.com/books",
      region: null,
    });
  });

  it("refuses what it can't use", () => {
    expect(parseLink("https://amzn.to/3abcd").ok).toBe(false);
    expect(parseLink("javascript:alert(1)").ok).toBe(false);
    expect(parseLink("ftp://example.com").ok).toBe(false);
    expect(parseLink("not a url").ok).toBe(false);
    expect(parseLink("https://www.amazon.com/s?k=litrpg").ok).toBe(false);
    expect(parseLink("https://www.royalroad.com/fictions/best-rated").ok).toBe(false);
  });
});

describe("dates", () => {
  it("reads every precision", () => {
    expect(parseDate("2026-03-14")).toEqual({ date: "2026-03-14", precision: "day" });
    expect(parseDate("2026-3")).toEqual({ date: "2026-03-01", precision: "month" });
    expect(parseDate("2026")).toEqual({ date: "2026-01-01", precision: "year" });
    expect(parseDate("Q3 2027")).toEqual({ date: "2027-07-01", precision: "quarter" });
    expect(parseDate("2027-Q1")).toEqual({ date: "2027-01-01", precision: "quarter" });
    expect(parseDate("March 14th, 2026")).toEqual({ date: "2026-03-14", precision: "day" });
    expect(parseDate("Sept 2026")).toEqual({ date: "2026-09-01", precision: "month" });
    expect(parseDate("TBA")).toEqual({ date: null, precision: "tba" });
  });

  it("rejects impossible dates", () => {
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("2026-13")).toBeNull();
    expect(parseDate("sometime soon")).toBeNull();
  });
});
