import { describe, expect, it } from "vitest";
import {
  parseReadingList,
  ReadingList,
  READING_LIST_KEY,
  READING_LIST_VERSION,
  toReadingListItem,
  type ReadingListPayload,
  type ReadingListStorage,
} from "../src/readingList.js";
import { sampleDoc } from "./helpers.js";

function memoryStorage(initial: unknown = null): { storage: ReadingListStorage; writes: ReadingListPayload[] } {
  const writes: ReadingListPayload[] = [];
  return {
    writes,
    storage: {
      async load() {
        return initial;
      },
      async save(payload) {
        writes.push(payload);
      },
    },
  };
}

describe("toReadingListItem", () => {
  it("keeps the fields the list renders", () => {
    const item = toReadingListItem(sampleDoc(), 1234);
    expect(item).toEqual({
      id: 7288,
      title: "Attention Is All You Need",
      author: "Ashish Vaswani; Noam Shazeer",
      year: "2017",
      source: "arxiv",
      source_label: "arXiv",
      license: "CC-BY-4.0",
      access_level: "public_full_text",
      url: "https://arxiv.org/abs/1706.03762",
      savedAt: 1234,
    });
  });

  it("does not carry empty fields", () => {
    const item = toReadingListItem({ id: 5, title: "", author: "", url: "" }, 1);
    expect(item).toEqual({ id: 5, title: "Untitled", savedAt: 1 });
  });
});

describe("parseReadingList", () => {
  it("accepts the stored payload, a bare array, and junk", () => {
    const items = [{ id: 1, title: "A", savedAt: 5 }];
    expect(parseReadingList({ items })).toEqual(items);
    expect(parseReadingList(items)).toEqual(items);
    expect(parseReadingList(null)).toEqual([]);
    expect(parseReadingList({ items: "nope" })).toEqual([]);
  });

  it("drops entries without a usable id and de-duplicates", () => {
    const parsed = parseReadingList({
      items: [{ id: 1, title: "A" }, { title: "no id" }, { id: 1, title: "dup" }, { id: "7", title: "B" }],
    });
    expect(parsed.map((item) => item.id)).toEqual([1, 7]);
    expect(parsed[1].title).toBe("B");
  });

  it("fills in defaults for a partial entry", () => {
    const parsed = parseReadingList({ items: [{ id: 3 }] });
    expect(parsed[0]).toEqual({ id: 3, title: "Untitled", savedAt: 0 });
  });
});

describe("ReadingList", () => {
  it("adds newest-first and reports whether anything changed", async () => {
    const { storage, writes } = memoryStorage({ items: [] });
    const list = new ReadingList(storage, () => 1000);
    await list.init();
    expect(list.size()).toBe(0);

    expect(await list.add(sampleDoc())).toBe(true);
    expect(await list.add(sampleDoc({ id: 9, title: "Second" }))).toBe(true);
    expect(await list.add(sampleDoc())).toBe(false); // already there, no duplicate
    expect(list.list().map((item) => item.id)).toEqual([9, 7288]);
    expect(writes.at(-1)).toEqual({
      version: READING_LIST_VERSION,
      items: list.list(),
    });
  });

  it("toggles membership and reports the resulting state", async () => {
    const { storage } = memoryStorage(null);
    const list = new ReadingList(storage, () => 1);
    await list.init();
    expect(await list.toggle(sampleDoc())).toBe(true);
    expect(list.has(7288)).toBe(true);
    expect(await list.toggle(sampleDoc())).toBe(false);
    expect(list.has(7288)).toBe(false);
  });

  it("removes by id and no-ops on an unknown id", async () => {
    const { storage } = memoryStorage({ items: [{ id: 1, title: "A", savedAt: 1 }] });
    const list = new ReadingList(storage, () => 1);
    await list.init();
    expect(await list.remove(999)).toBe(false);
    expect(await list.remove(1)).toBe(true);
    expect(list.list()).toEqual([]);
  });

  it("starts empty when the stored data is unreadable", async () => {
    const list = new ReadingList(
      {
        async load() {
          throw new Error("corrupt");
        },
        async save() {},
      },
      () => 1,
    );
    await list.init();
    expect(list.list()).toEqual([]);
  });

  it("exports the list as markdown through the shared builder", async () => {
    const { storage } = memoryStorage({ items: [{ id: 7288, title: "Attention Is All You Need", savedAt: 1 }] });
    const list = new ReadingList(storage, () => 1);
    await list.init();
    expect(list.markdown()).toContain("- [ ] [Attention Is All You Need](https://www.conceptio.app/document/7288)");
    expect(READING_LIST_KEY).toBe("readingList");
  });
});
