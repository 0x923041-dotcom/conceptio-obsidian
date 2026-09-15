/**
 * Offline stub of the `obsidian` runtime surface the plugin uses.
 *
 * Vitest aliases `obsidian` here (see vitest.config.ts); the real package is
 * types-only at build time and a desktop runtime at run time, neither of which
 * is available to a unit test. Only the parts the plugin actually calls are
 * implemented — and they are real enough to assert against.
 */

export interface CommandLike {
  id: string;
  name: string;
  callback?: () => unknown;
}

/** One command registered with the Obsidian CLI (1.12.2+). */
export interface CliRegistration {
  command: string;
  description: string;
  flags: Record<string, { value?: string; description: string; required?: boolean }> | null;
  handler: (params: Record<string, string | "true">) => string | Promise<string>;
}

export class TFile {}
export class TFolder {}
export class MarkdownView {
  editor: unknown = null;
}

export class App {}

/** Every Notice raised during a test, newest last. */
export const notices: Array<{ message: string; timeout?: number }> = [];

export function clearNotices(): void {
  notices.length = 0;
}

export class Notice {
  constructor(
    public message: string,
    public timeout?: number,
  ) {
    notices.push({ message, timeout });
  }
}

/** A minimal DOM-ish element supporting Obsidian's createEl/createDiv API. */
export class MockEl {
  children: MockEl[] = [];
  text = "";
  cls = "";
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(public readonly tag: string) {}

  empty(): this {
    this.children = [];
    this.text = "";
    return this;
  }

  createEl(tag: string, opts?: { cls?: string; text?: string }): MockEl {
    const el = new MockEl(tag);
    if (opts?.cls) el.cls = opts.cls;
    if (opts?.text) el.text = opts.text;
    this.children.push(el);
    return el;
  }

  createDiv(opts?: { cls?: string; text?: string }): MockEl {
    return this.createEl("div", opts);
  }

  setText(text: string): this {
    this.text = text;
    return this;
  }

  addEventListener(type: string, callback: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(callback);
    this.listeners.set(type, list);
  }

  focus(): void {}
}

/** All Setting instances constructed during a test, oldest first. */
export const settingsInstances: Setting[] = [];

export function clearSettingsInstances(): void {
  settingsInstances.length = 0;
}

export class TextComponent {
  value = "";
  placeholder = "";
  inputEl = new MockEl("input");
  private change?: (value: string) => unknown;

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.change = cb;
    return this;
  }

  /** Test hook — types a value into the component. */
  type(value: string): void {
    this.value = value;
    void this.change?.(value);
  }
}

export class ToggleComponent {
  value = false;
  private change?: (value: boolean) => unknown;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  onChange(cb: (value: boolean) => unknown): this {
    this.change = cb;
    return this;
  }

  toggle(value: boolean): void {
    this.value = value;
    void this.change?.(value);
  }
}

export class DropdownComponent {
  value = "";
  options: Array<{ value: string; display: string }> = [];
  private change?: (value: string) => unknown;

  addOption(value: string, display: string): this {
    this.options.push({ value, display });
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(cb: (value: string) => unknown): this {
    this.change = cb;
    return this;
  }

  select(value: string): void {
    this.value = value;
    void this.change?.(value);
  }
}

export class ButtonComponent {
  text = "";
  cta = false;
  private click?: () => unknown;

  setButtonText(value: string): this {
    this.text = value;
    return this;
  }

  setCta(): this {
    this.cta = true;
    return this;
  }

  onClick(cb: () => unknown): this {
    this.click = cb;
    return this;
  }

  /** Test hook — presses the button. */
  press(): void {
    void this.click?.();
  }
}

export class Setting {
  name = "";
  desc = "";
  texts: TextComponent[] = [];
  toggles: ToggleComponent[] = [];
  dropdowns: DropdownComponent[] = [];
  buttons: ButtonComponent[] = [];

  constructor(public readonly containerEl: unknown) {
    settingsInstances.push(this);
  }

  setName(value: string): this {
    this.name = value;
    return this;
  }

  setDesc(value: string): this {
    this.desc = value;
    return this;
  }

  addText(cb: (text: TextComponent) => unknown): this {
    const component = new TextComponent();
    cb(component);
    this.texts.push(component);
    return this;
  }

  addToggle(cb: (toggle: ToggleComponent) => unknown): this {
    const component = new ToggleComponent();
    cb(component);
    this.toggles.push(component);
    return this;
  }

  addDropdown(cb: (dropdown: DropdownComponent) => unknown): this {
    const component = new DropdownComponent();
    cb(component);
    this.dropdowns.push(component);
    return this;
  }

  addButton(cb: (button: ButtonComponent) => unknown): this {
    const component = new ButtonComponent();
    cb(component);
    this.buttons.push(component);
    return this;
  }
}

export class Modal {
  contentEl = new MockEl("div") as unknown as HTMLElement;
  titleEl = new MockEl("div") as unknown as HTMLElement;
  opened = false;

  constructor(public app: unknown) {}

  open(): void {
    this.opened = true;
    this.onOpen();
  }

  close(): void {
    this.opened = false;
    this.onClose();
  }

  onOpen(): void {}

  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  placeholder = "";

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }

  renderSuggestion(_value: T, _el: HTMLElement): void {}

  onChooseSuggestion(_value: T, _evt?: unknown): void {}
}

export class Plugin {
  commands: CommandLike[] = [];
  ribbonIcons: Array<{ icon: string; title: string }> = [];
  settingTabs: PluginSettingTab[] = [];
  /** Commands claimed in the Obsidian CLI, in registration order. */
  cliHandlers: CliRegistration[] = [];
  private data: unknown = null;

  constructor(
    public app: unknown,
    public manifest?: unknown,
  ) {}

  addRibbonIcon(icon: string, title: string, _callback: () => unknown): HTMLElement {
    this.ribbonIcons.push({ icon, title });
    return new MockEl("div") as unknown as HTMLElement;
  }

  addCommand(command: CommandLike): CommandLike {
    this.commands.push(command);
    return command;
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.settingTabs.push(tab);
  }

  /**
   * Mirrors Obsidian's own contract: command IDs are globally unique, and
   * re-registering one throws rather than silently replacing it.
   */
  registerCliHandler(
    command: string,
    description: string,
    flags: CliRegistration["flags"],
    handler: CliRegistration["handler"],
  ): void {
    if (this.cliHandlers.some((entry) => entry.command === command)) {
      throw new Error(`Command "${command}" is already registered as a handler.`);
    }
    this.cliHandlers.push({ command, description, flags, handler });
  }

  registerEvent(): void {}

  async loadData(): Promise<unknown> {
    return this.data;
  }

  async saveData(data: unknown): Promise<void> {
    this.data = data;
  }

  /** Test hook — what the plugin has persisted so far. */
  savedData(): unknown {
    return this.data;
  }
}

export class PluginSettingTab {
  containerEl = new MockEl("div") as unknown as HTMLElement;

  constructor(
    public app: unknown,
    public plugin: unknown,
  ) {}

  display(): void {}
}

/** The `workspace` surface the plugin uses. */
export interface WorkspaceLike {
  getActiveViewOfType(_type: unknown): { editor: unknown } | null;
  openLinkText(path: string, source: string, newLeaf: boolean): Promise<void>;
}

/** A fake {@link App} with a recording vault and workspace. */
export function fakeApp(options: {
  editor?: unknown;
  files?: string[];
} = {}): {
  app: App;
  files: Map<string, string>;
  folders: string[];
  opened: string[];
  modified: string[];
} {
  const files = new Map<string, string>();
  for (const path of options.files ?? []) files.set(path, "");
  const folders: string[] = [];
  const opened: string[] = [];
  const modified: string[] = [];

  const vault = {
    getAbstractFileByPath(path: string): unknown {
      if (files.has(path)) return new TFile();
      if (folders.includes(path)) return new TFolder();
      return null;
    },
    async createFolder(path: string): Promise<void> {
      folders.push(path);
    },
    async create(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async modify(file: unknown, content: string): Promise<void> {
      modified.push(content);
      for (const [path, value] of files) {
        if (value === "" && path) {
          files.set(path, content);
          break;
        }
      }
      void file;
    },
  };

  const workspace = {
    getActiveViewOfType(): { editor: unknown } | null {
      return options.editor ? { editor: options.editor } : null;
    },
    async openLinkText(path: string): Promise<void> {
      opened.push(path);
    },
  };

  const app = { vault, workspace } as unknown as App;
  return { app, files, folders, opened, modified };
}
