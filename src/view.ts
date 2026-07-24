import { FuzzySuggestModal, ItemView, MarkdownRenderer, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type DiscussionHubPlugin from "./plugin";
import type { RegisteredDiscussionModel } from "./plugin";
import type { UserInputRequest, UserInputResponse } from "./discussionEngine";
import {
  USER_MODEL_ID,
  USER_PROVIDER_ID,
  type DiscussionAttachment,
  type DiscussionParticipant,
  type DiscussionResult,
  type DiscussionVoter,
  type OpenDiscussionRequest,
} from "./types";

export const DISCUSSION_VIEW_TYPE = "discussion-hub-view";

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ModelPickerItem {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
}

function attachmentType(mimeType: string): DiscussionAttachment["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "text";
}

async function readAttachment(file: File): Promise<DiscussionAttachment> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const mimeType = file.type || "text/plain";
  return { name: file.name, mimeType, data, type: attachmentType(mimeType) };
}

export class DiscussionView extends ItemView {
  private theme = "";
  private attachments: DiscussionAttachment[] = [];
  private running = false;
  private stopCurrent: (() => void) | null = null;
  private readonly markdownRenderTimers = new WeakMap<HTMLElement, number>();
  private readonly markdownRenderVersions = new WeakMap<HTMLElement, number>();

  constructor(leaf: WorkspaceLeaf, private readonly discussionPlugin: DiscussionHubPlugin) {
    super(leaf);
  }

  getViewType(): string { return DISCUSSION_VIEW_TYPE; }
  getDisplayText(): string { return "Discussion Hub"; }
  getIcon(): string { return "messages-square"; }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.stopCurrent?.();
  }

  setDraft(request: OpenDiscussionRequest): void {
    if (request.theme !== undefined) this.theme = request.theme;
    if (request.attachments?.length) this.attachments = [...this.attachments, ...request.attachments];
    if (!this.running) void this.render();
  }

  async render(): Promise<void> {
    if (this.running) return;
    const root = this.contentEl;
    root.empty();
    root.addClass("discussion-hub-view");
    root.createEl("h2", { text: "AI Discussion" });
    root.createEl("p", { cls: "discussion-hub-subtitle", text: "Combine models from every connected AI plugin in one discussion." });

    const models = await this.discussionPlugin.listModels();
    if (models.length === 0) {
      const providers = this.discussionPlugin.getConnectedProviderNames();
      const warning = root.createDiv({ cls: "discussion-hub-warning" });
      warning.createDiv({
        text: providers.length > 0
          ? `Connected provider(s) (${providers.join(", ")}) have not supplied any text models. Check their model settings.`
          : "No AI provider is connected. Enable LLM Hub, Gemini Helper, or Local LLM Hub.",
      });
      const reconnect = warning.createEl("button", { text: "Reconnect providers" });
      reconnect.onclick = () => {
        this.discussionPlugin.requestProviderRegistration();
        void this.render();
      };
    }

    const themeArea = root.createEl("textarea", { cls: "discussion-hub-theme", attr: { placeholder: "Discussion theme" } });
    themeArea.value = this.theme;
    themeArea.addEventListener("input", () => { this.theme = themeArea.value; });

    const turnRow = root.createDiv({ cls: "discussion-hub-inline" });
    turnRow.createEl("label", { text: "Turns" });
    const turnsInput = turnRow.createEl("input", { type: "number", attr: { min: "1", max: "20" } });
    turnsInput.value = String(this.discussionPlugin.settings.defaultTurns);

    const attachButton = turnRow.createEl("button", { text: "Attach files" });
    const fileInput = turnRow.createEl("input", { type: "file", attr: { multiple: "true" } });
    fileInput.addClass("discussion-hub-hidden-input");
    attachButton.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      for (const file of Array.from(fileInput.files ?? [])) {
        if (file.size > 20 * 1024 * 1024) { new Notice(`${file.name} exceeds 20 MB.`); continue; }
        this.attachments.push(await readAttachment(file));
      }
      void this.render();
    };
    if (this.attachments.length > 0) {
      const list = root.createDiv({ cls: "discussion-hub-attachments" });
      for (const [index, attachment] of this.attachments.entries()) {
        const pill = list.createSpan({ cls: "discussion-hub-pill", text: attachment.name });
        const remove = pill.createEl("button", { text: "×", attr: { "aria-label": `Remove ${attachment.name}` } });
        remove.onclick = () => { this.attachments.splice(index, 1); void this.render(); };
      }
    }

    this.renderPeopleSection(root, "Discussion participants", this.discussionPlugin.settings.participants, models, false);
    this.renderPeopleSection(root, "Vote participants", this.discussionPlugin.settings.voters, models, true);

    const actions = root.createDiv({ cls: "discussion-hub-actions" });
    const start = actions.createEl("button", { cls: "mod-cta", text: "Start discussion" });
    start.disabled = models.length === 0 && !this.discussionPlugin.settings.participants.some((item) => item.providerId === USER_PROVIDER_ID);
    start.onclick = () => void this.start(Math.max(1, Math.min(20, Number(turnsInput.value) || 2)));
  }

  private renderPeopleSection(
    root: HTMLElement,
    title: string,
    people: DiscussionParticipant[] | DiscussionVoter[],
    models: RegisteredDiscussionModel[],
    voters: boolean,
  ): void {
    const section = root.createDiv({ cls: "discussion-hub-section" });
    section.createEl("h3", { text: title });
    for (const person of people) {
      const row = section.createDiv({ cls: "discussion-hub-person" });
      row.createSpan({ text: person.displayName });
      if (!voters) {
        const role = row.createEl("input", { type: "text", attr: { placeholder: "Role / position" } });
        role.value = (person as DiscussionParticipant).role || "";
        role.onchange = () => {
          (person as DiscussionParticipant).role = role.value.trim() || undefined;
          void this.persistPeople();
        };
      }
      const remove = row.createEl("button", { text: "Remove" });
      remove.onclick = () => {
        const index = people.findIndex((item) => item.id === person.id);
        if (index >= 0) people.splice(index, 1);
        void this.persistPeople().then(() => this.render());
      };
    }

    const pickerItems: ModelPickerItem[] = [
      { providerId: USER_PROVIDER_ID, providerName: "Human", modelId: USER_MODEL_ID, displayName: "You" },
      ...models.map((model) => ({
        providerId: model.providerId,
        providerName: model.providerName,
        modelId: model.id,
        displayName: model.name,
      })),
    ];
    const add = section.createEl("button", { text: voters ? "Add voter" : "Add participant" });
    add.onclick = () => {
      new ModelPickerModal(this.app, pickerItems, (item) => {
        const ref = { providerId: item.providerId, modelId: item.modelId };
        if (voters) (people as DiscussionVoter[]).push({ id: id("voter"), ...ref, displayName: item.displayName });
        else (people as DiscussionParticipant[]).push({ id: id("participant"), ...ref, displayName: item.displayName });
        void this.persistPeople().then(() => this.render());
      }).open();
    };
  }

  private persistPeople(): Promise<void> {
    return this.discussionPlugin.updateParticipants(
      this.discussionPlugin.settings.participants,
      this.discussionPlugin.settings.voters,
    );
  }

  private async start(turns: number): Promise<void> {
    const theme = this.theme.trim();
    if (!theme) { new Notice("Enter a discussion theme."); return; }
    if (this.discussionPlugin.settings.participants.length === 0) { new Notice("Add at least one participant."); return; }
    if (this.discussionPlugin.settings.voters.length === 0) { new Notice("Add at least one voter."); return; }

    this.running = true;
    const root = this.contentEl;
    root.empty();
    root.addClass("discussion-hub-view");
    root.createEl("h2", { text: theme });
    const toolbar = root.createDiv({ cls: "discussion-hub-inline" });
    const status = toolbar.createSpan({ cls: "discussion-hub-status", text: "Starting…" });
    const stop = toolbar.createEl("button", { text: "Stop" });
    const output = root.createDiv({ cls: "discussion-hub-output" });
    const cards = new Map<string, HTMLElement>();
    const engine = this.discussionPlugin.createEngine(this.attachments);
    this.stopCurrent = () => engine.stop();
    stop.onclick = this.stopCurrent;
    const streamCard = (participantId: string, content: string, conclusion: boolean) => {
      const key = `${conclusion ? "conclusion" : "response"}:${participantId}`;
      let card = cards.get(key);
      if (!card) {
        card = output.createDiv({ cls: `discussion-hub-card${conclusion ? " is-conclusion" : ""}` });
        const person = this.discussionPlugin.settings.participants.find((item) => item.id === participantId);
        card.createEl("h4", { text: `${conclusion ? "Conclusion — " : ""}${person?.displayName || participantId}` });
        card.createEl("div", { cls: "discussion-hub-card-content" });
        cards.set(key, card);
      }
      const contentEl = card.querySelector<HTMLElement>(".discussion-hub-card-content");
      if (contentEl) this.renderMarkdown(contentEl, content);
    };
    engine.setCallbacks({
      onPhaseChange: (phase) => status.setText(phase[0].toUpperCase() + phase.slice(1)),
      onTurnStart: (turn) => output.createEl("h3", { text: `Turn ${turn}` }),
      onResponseStream: (participantId, content) => streamCard(participantId, content, false),
      onConclusionStream: (participantId, content) => streamCard(participantId, content, true),
      onUserInputRequest: (request) => new Promise((resolve) => new UserInputModal(this.app, request, resolve).open()),
    });
    try {
      const result = await engine.run(theme, turns, this.discussionPlugin.settings.participants, this.discussionPlugin.settings.voters);
      this.renderResult(output, result);
      stop.setText("Save as note");
      stop.onclick = () => void this.discussionPlugin.saveResult(result).then(async (file) => {
        new Notice(`Discussion saved to ${file.path}`);
        await this.app.workspace.getLeaf(true).openFile(file);
      });
      const again = toolbar.createEl("button", { text: "New discussion" });
      again.onclick = () => { this.running = false; this.stopCurrent = null; void this.render(); };
    } catch (error) {
      status.setText(error instanceof Error && error.name === "AbortError" ? "Stopped" : "Error");
      output.createDiv({ cls: "discussion-hub-warning", text: error instanceof Error ? error.message : String(error) });
      stop.setText("Back");
      stop.onclick = () => { this.running = false; this.stopCurrent = null; void this.render(); };
    }
  }

  private renderResult(output: HTMLElement, result: DiscussionResult): void {
    output.createEl("h3", { text: "Voting results" });
    for (const vote of result.votes) output.createEl("p", { text: `${vote.voterDisplayName} → ${vote.votedForDisplayName}${vote.reason ? `: ${vote.reason}` : ""}` });
    output.createEl("h3", { text: result.isDraw ? "Draw" : result.winnerId ? "Winner" : "No winner" });
    if (result.finalConclusion) {
      const winner = output.createDiv({ cls: "discussion-hub-card is-winner" });
      this.renderMarkdown(winner, result.finalConclusion, 0);
    }
  }

  private renderMarkdown(target: HTMLElement, markdown: string, delay = 60): void {
    const currentTimer = this.markdownRenderTimers.get(target);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer);
    const version = (this.markdownRenderVersions.get(target) ?? 0) + 1;
    this.markdownRenderVersions.set(target, version);
    const timer = window.setTimeout(() => {
      this.markdownRenderTimers.delete(target);
      const staging = document.createElement("div");
      void MarkdownRenderer.render(this.app, markdown, staging, "", this).then(() => {
        if (this.markdownRenderVersions.get(target) !== version) return;
        target.replaceChildren(...Array.from(staging.childNodes));
      });
    }, delay);
    this.markdownRenderTimers.set(target, timer);
  }
}

class ModelPickerModal extends FuzzySuggestModal<ModelPickerItem> {
  constructor(
    app: DiscussionView["app"],
    private readonly items: ModelPickerItem[],
    private readonly onChoose: (item: ModelPickerItem) => void,
  ) {
    super(app);
    this.setPlaceholder("Search by provider, model name, or model ID…");
    this.emptyStateText = "No matching models";
  }

  getItems(): ModelPickerItem[] {
    return this.items;
  }

  getItemText(item: ModelPickerItem): string {
    const id = item.modelId === item.displayName ? "" : ` (${item.modelId})`;
    return `${item.providerName} — ${item.displayName}${id}`;
  }

  onChooseItem(item: ModelPickerItem): void {
    this.onChoose(item);
  }
}

class UserInputModal extends Modal {
  private settled = false;

  constructor(
    app: DiscussionView["app"],
    private readonly request: UserInputRequest,
    private readonly resolveInput: (value: UserInputResponse) => void,
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText(this.request.type === "vote" ? `${this.request.displayName}: cast your vote` : `${this.request.displayName}: your turn`);
    if (this.request.type === "vote") {
      let selected = this.request.candidates?.[0]?.id || "";
      let reason = "";
      new Setting(this.contentEl).setName("Vote").addDropdown((dropdown) => {
        for (const candidate of this.request.candidates ?? []) dropdown.addOption(candidate.id, candidate.displayName);
        dropdown.onChange((value) => { selected = value; });
      });
      new Setting(this.contentEl).setName("Reason").addTextArea((text) => text.onChange((value) => { reason = value; }));
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Submit vote").setCta().onClick(() => {
        this.settled = true; this.resolveInput({ content: "", votedForId: selected, reason }); this.close();
      }));
    } else {
      let content = "";
      new Setting(this.contentEl).setName(this.request.role ? `Role: ${this.request.role}` : "Response").addTextArea((text) => text.onChange((value) => { content = value; }));
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Submit").setCta().onClick(() => {
        this.settled = true; this.resolveInput({ content }); this.close();
      }));
    }
  }

  onClose(): void {
    if (!this.settled) this.resolveInput({ content: "" });
  }
}
