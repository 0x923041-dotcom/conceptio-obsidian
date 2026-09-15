import { describe, expect, it } from "vitest";
import {
  clampLimit,
  DataStore,
  DEFAULT_SETTINGS,
  normalizeSettings,
  parseTags,
} from "../src/settings.js";

describe("normalizeSettings", () => {
  it("returns the defaults for junk input", () => {
    for (const junk of [null, undefined, "nope", 42, []]) {
      expect(normalizeSettings(junk)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("merges stored values over the defaults", () => {
    const settings = normalizeSettings({ apiKey: " ckey_live_x ", resultLimit: 25, frontmatter: false });
    expect(settings.apiKey).toBe("ckey_live_x");
    expect(settings.resultLimit).toBe(25);
    expect(settings.frontmatter).toBe(false);
    // Untouched keys keep their defaults.
    expect(settings.noteFolder).toBe(DEFAULT_SETTINGS.noteFolder);
    expect(settings.citationFormat).toBe(DEFAULT_SETTINGS.citationFormat);
  });

  it("normalises the origin and refuses an empty one", () => {
    expect(normalizeSettings({ apiBase: "https://self.test///" }).apiBase).toBe("https://self.test");
    expect(normalizeSettings({ apiBase: "   " }).apiBase).toBe(DEFAULT_SETTINGS.apiBase);
  });

  it("rejects an unknown citation format", () => {
    expect(normalizeSettings({ citationFormat: "vancouver" }).citationFormat).toBe(DEFAULT_SETTINGS.citationFormat);
    expect(normalizeSettings({ citationFormat: "ieee" }).citationFormat).toBe("ieee");
  });

  it("clamps the result limit to the server range", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(500)).toBe(100);
    expect(clampLimit("20")).toBe(20);
    expect(clampLimit("nope")).toBe(DEFAULT_SETTINGS.resultLimit);
    expect(normalizeSettings({ resultLimit: "7" }).resultLimit).toBe(7);
  });
});

describe("parseTags", () => {
  it("splits, trims, and de-duplicates", () => {
    expect(parseTags(" conceptio, papers ,, conceptio ")).toEqual(["conceptio", "papers"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(undefined as unknown as string)).toEqual([]);
  });
});

describe("DataStore", () => {
  function memoryIO(initial: unknown = null): {
    io: { load(): Promise<unknown>; save(data: Record<string, unknown>): Promise<void> };
    saved: Record<string, unknown>[];
  } {
    const saved: Record<string, unknown>[] = [];
    return {
      saved,
      io: {
        async load() {
          return initial;
        },
        async save(data) {
          saved.push(data);
        },
      },
    };
  }

  it("reads namespaces and falls back when absent", async () => {
    const { io } = memoryIO({ settings: { apiKey: "k" }, other: 1 });
    const store = new DataStore(io);
    await store.init();
    expect(store.get("settings", null)).toEqual({ apiKey: "k" });
    expect(store.get("missing", "fallback")).toBe("fallback");
  });

  it("survives unreadable data", async () => {
    const store = new DataStore({
      async load() {
        throw new Error("corrupt data.json");
      },
      async save() {},
    });
    await store.init();
    expect(store.get("settings", null)).toBeNull();
  });

  it("writes one namespace without dropping the others", async () => {
    const { io, saved } = memoryIO({ settings: { apiKey: "k" } });
    const store = new DataStore(io);
    await store.init();
    await store.set("readingList", { version: 1, items: [] });
    expect(saved[0]).toEqual({ settings: { apiKey: "k" }, readingList: { version: 1, items: [] } });
  });

  it("initialises implicitly when written before init", async () => {
    const { io, saved } = memoryIO({ settings: { apiKey: "k" } });
    const store = new DataStore(io);
    await store.set("readingList", { version: 1, items: [] });
    expect(saved[0]).toEqual({ settings: { apiKey: "k" }, readingList: { version: 1, items: [] } });
  });

  it("treats a non-object document as empty", async () => {
    const store = new DataStore({
      async load() {
        return [1, 2, 3];
      },
      async save() {},
    });
    await store.init();
    expect(store.get("anything", "fallback")).toBe("fallback");
  });
});
