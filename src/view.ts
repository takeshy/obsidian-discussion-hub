import { FuzzySuggestModal, ItemView, MarkdownRenderer, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import type DiscussionHubPlugin from "./plugin";
import type { RegisteredDiscussionModel } from "./plugin";
import type { UserInputRequest, UserInputResponse } from "./discussionEngine";
import { KEYWORD_WOLF_PAIRS, randomKeywordWolfPair } from "./keywordWolfPairs";
import {
  USER_MODEL_ID,
  USER_PROVIDER_ID,
  type ActivityMode,
  type DiscussionAttachment,
  type DiscussionParticipant,
  type DiscussionResult,
  type DiscussionRunSettings,
  type DiscussionVoteResult,
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
  private activityMode: ActivityMode = "discussion";
  private majorityKeyword = "";
  private minorityKeyword = "";
  private keywordSource: "random" | "custom" = "random";
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

    const modeRow = root.createDiv({ cls: "discussion-hub-inline" });
    modeRow.createEl("label", { text: "Activity" });
    const mode = modeRow.createEl("select");
    mode.createEl("option", { value: "discussion", text: "Discussion" });
    mode.createEl("option", { value: "riddle", text: "Riddle & mystery" });
    mode.createEl("option", { value: "keyword-wolf", text: "Keyword Wolf" });
    mode.value = this.activityMode;
    mode.onchange = () => { this.activityMode = mode.value as ActivityMode; void this.render(); };

    if (this.activityMode === "keyword-wolf") {
      const sourceRow = root.createDiv({ cls: "discussion-hub-inline" });
      sourceRow.createEl("label", { text: "Keywords" });
      const source = sourceRow.createEl("select");
      source.createEl("option", { value: "random", text: `Random (${KEYWORD_WOLF_PAIRS.length} bundled pairs)` });
      source.createEl("option", { value: "custom", text: "Custom" });
      source.value = this.keywordSource;
      source.onchange = () => { this.keywordSource = source.value as "random" | "custom"; void this.render(); };
      if (this.keywordSource === "custom") {
        const keywords = root.createDiv({ cls: "discussion-hub-keywords" });
        const majority = keywords.createEl("input", { type: "text", attr: { placeholder: "Majority keyword" } });
        majority.value = this.majorityKeyword;
        majority.oninput = () => { this.majorityKeyword = majority.value; };
        const minority = keywords.createEl("input", { type: "text", attr: { placeholder: "Wolf keyword" } });
        minority.value = this.minorityKeyword;
        minority.oninput = () => { this.minorityKeyword = minority.value; };
      }
      root.createEl("p", { cls: "discussion-hub-subtitle", text: "One random player receives the wolf keyword. Every player, including You, sees only their own keyword and is never told whether it is the majority one." });
    } else {
      const placeholder = this.activityMode === "riddle"
        ? "Enter a riddle, mystery, case, situation, or logic problem…"
        : "Discussion theme";
      const themeArea = root.createEl("textarea", { cls: "discussion-hub-theme", attr: { placeholder } });
      themeArea.value = this.theme;
      themeArea.addEventListener("input", () => { this.theme = themeArea.value; });
    }

    const turnRow = root.createDiv({ cls: "discussion-hub-inline" });
    turnRow.createEl("label", { text: "Turns" });
    const turnsInput = turnRow.createEl("input", { type: "number", attr: { min: "1", max: "20" } });
    // A riddle is solved in one collaborative pass, so it does not need the usual back-and-forth.
    turnsInput.value = String(this.activityMode === "riddle" ? 1 : this.discussionPlugin.settings.defaultTurns);

    if (this.activityMode !== "keyword-wolf") {
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
    }

    this.renderPeopleSection(root, "Discussion participants", this.discussionPlugin.settings.participants, models, false);
    if (this.activityMode === "discussion") {
      this.renderPeopleSection(root, "Vote participants", this.discussionPlugin.settings.voters, models, true);
    } else if (this.activityMode === "keyword-wolf") {
      root.createEl("p", { cls: "discussion-hub-voter-note", text: "Every player votes, and may vote for themselves." });
    }

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
    let theme = this.theme.trim();
    if (this.activityMode === "keyword-wolf") {
      if (this.keywordSource === "custom" && (!this.majorityKeyword.trim() || !this.minorityKeyword.trim())) { new Notice("Enter both Keyword Wolf keywords."); return; }
      theme = "Keyword Wolf";
    } else if (!theme) { new Notice("Enter a discussion theme."); return; }
    if (this.discussionPlugin.settings.participants.length === 0) { new Notice("Add at least one participant."); return; }
    if (this.activityMode === "discussion" && this.discussionPlugin.settings.voters.length === 0) { new Notice("Add at least one voter."); return; }
    if (this.activityMode === "keyword-wolf" && this.discussionPlugin.settings.participants.length < 3) { new Notice("Keyword Wolf needs at least three participants."); return; }

    let participants = this.discussionPlugin.settings.participants.map((item) => ({ ...item }));
    let voters = this.discussionPlugin.settings.voters.map((item) => ({ ...item }));
    let settings: DiscussionRunSettings = { ...this.discussionPlugin.settings, activityMode: this.activityMode };
    let keywordWolfReveal = "";
    let wolfId = "";
    if (this.activityMode === "riddle") {
      settings = {
        ...settings,
        enableVoting: false,
        systemPrompt: `${settings.systemPrompt}\nWork together to solve the riddle, mystery, case, situation, or logic problem. Separate facts from hypotheses and examine clues, contradictions, and alternatives.`,
        conclusionPrompt: "State your final answer or theory, explain how the key clues support it, and identify anything still uncertain.",
      };
    } else if (this.activityMode === "keyword-wolf") {
      const selectedPair = this.keywordSource === "random"
        ? randomKeywordWolfPair()
        : { majority: this.majorityKeyword.trim(), wolf: this.minorityKeyword.trim() };
      const wolfIndex = Math.floor(Math.random() * participants.length);
      participants = participants.map((participant, index) => ({
        ...participant,
        role: `${participant.role ? `${participant.role}\n` : ""}Your secret keyword: ${index === wolfIndex ? selectedPair.wolf : selectedPair.majority}.`,
      }));
      voters = participants.map((participant) => ({
        id: `keyword-wolf-voter-${participant.id}`,
        providerId: participant.providerId,
        modelId: participant.modelId,
        displayName: participant.displayName,
        privateInstruction: participant.role,
        selfParticipantId: participant.id,
      }));
      wolfId = participants[wolfIndex].id;
      keywordWolfReveal = `Majority keyword: ${selectedPair.majority}. The Keyword Wolf was ${participants[wolfIndex].displayName} (keyword: ${selectedPair.wolf}).`;
      settings = {
        ...settings,
        enableVoting: true,
        allowDrawVote: false,
        systemPrompt: "You are playing Keyword Wolf. Every player holds a secret keyword: all but one share the same keyword, and one player — the wolf — holds a subtly different one."
          + " Nobody is told which of the two they hold, including you."
          + " Never say your keyword verbatim. Give clues specific enough to be compared, watch for an answer that does not fit your own keyword,"
          + " and work out as the game goes on whether you are the odd one out."
          + "\n\nHow the game is decided: the wolf wins outright if it votes for itself while no other player votes for it;"
          + " a self-vote counts for nothing once another player has named the wolf; and the wolf loses when every other player votes for it."
          + " So if you conclude that you are the odd one out, stay unsuspected and then name yourself."
          + " If you conclude that you are not, name the wolf and bring the other players with you."
          + "\n\nYou are playing as your own model, against the others. Play to win: your model's reputation is on the line.",
        conclusionPrompt: "Name the player you suspect is the Keyword Wolf and briefly explain your reasoning.",
        votePrompt: "Vote for the player you believe is the Keyword Wolf. If you have concluded that you are the wolf yourself, vote for yourself.",
        activityMode: "keyword-wolf",
      };
    }

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
    const pendingPrompts = new Set<() => void>();
    let currentTurn = 0;
    const engine = this.discussionPlugin.createEngine(this.attachments, settings);
    // Stopping has to release anything waiting on the user, or the run would hang on an unanswered prompt.
    this.stopCurrent = () => {
      engine.stop();
      for (const cancel of [...pendingPrompts]) cancel();
    };
    stop.onclick = this.stopCurrent;
    const streamCard = (participantId: string, content: string, conclusion: boolean, turnNumber = currentTurn) => {
      const key = `${conclusion ? "conclusion" : `turn-${turnNumber}`}:${participantId}`;
      let card = cards.get(key);
      if (!card) {
        card = output.createDiv({ cls: `discussion-hub-card${conclusion ? " is-conclusion" : ""}` });
        const person = participants.find((item) => item.id === participantId);
        card.createEl("h4", { text: `${conclusion ? "Conclusion — " : ""}${person?.displayName || participantId}` });
        card.createEl("div", { cls: "discussion-hub-card-content" });
        cards.set(key, card);
      }
      const contentEl = card.querySelector<HTMLElement>(".discussion-hub-card-content");
      if (contentEl) this.renderMarkdown(contentEl, content);
    };
    let voteHeading: HTMLElement | null = null;
    const showVote = (vote: DiscussionVoteResult) => {
      if (!voteHeading) voteHeading = output.createEl("h3", { text: "Voting results" });
      output.createEl("p", { text: `${vote.voterDisplayName} → ${vote.votedForDisplayName}${vote.reason ? `: ${vote.reason}` : ""}` });
    };
    engine.setCallbacks({
      onPhaseChange: (phase) => status.setText(phase[0].toUpperCase() + phase.slice(1)),
      onTurnStart: (turn) => {
        currentTurn = turn;
        output.createEl("h3", { text: `Turn ${turn}` });
      },
      onResponseStream: (participantId, content) => streamCard(participantId, content, false),
      onTurnComplete: (turn) => {
        for (const response of turn.responses) streamCard(response.participantId, response.content || `[Error: ${response.error || "No response"}]`, false, turn.turnNumber);
      },
      onConclusionStream: (participantId, content) => streamCard(participantId, content, true),
      onConclusionComplete: (conclusion) => streamCard(conclusion.participantId, conclusion.content, true),
      onVoteComplete: showVote,
      onUserInputRequest: (request) => this.waitForUserAction(output, request, pendingPrompts),
    });
    try {
      const result = await engine.run(theme, turns, participants, voters);
      result.keywordWolfReveal = keywordWolfReveal
        ? `${keywordWolfReveal} ${this.keywordWolfVerdict(result, wolfId)}`
        : undefined;
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

  /** The wolf wins outright by naming itself while staying unnoticed, and loses once every other player names it. */
  private keywordWolfVerdict(result: DiscussionResult, wolfId: string): string {
    const wolfVoter = result.voters.find((voter) => voter.selfParticipantId === wolfId);
    const namedItself = result.votes.some((vote) => vote.voterId === wolfVoter?.id && vote.votedForId === wolfId);
    const others = result.votes.filter((vote) => vote.voterId !== wolfVoter?.id);
    const named = others.filter((vote) => vote.votedForId === wolfId).length;
    if (named === 0) {
      return namedItself
        ? "The Keyword Wolf wins outright: it named itself while nobody else did."
        : "The Keyword Wolf escapes: nobody named it.";
    }
    if (named === others.length) return "The Keyword Wolf loses: every other player named it.";
    return `The Keyword Wolf was named by ${named} of ${others.length} other players${namedItself ? ", so naming itself counted for nothing" : ""}.`;
  }

  private renderResult(output: HTMLElement, result: DiscussionResult): void {
    // Individual votes are already on screen; onVoteComplete renders them as they arrive.
    if (result.votes.length > 0) {
      if (result.activityMode === "keyword-wolf") {
        output.createEl("h3", { text: "Most suspected" });
        const suspected = result.winnerIds
          .map((id) => result.participants.find((participant) => participant.id === id)?.displayName)
          .filter((name): name is string => Boolean(name));
        output.createEl("p", { text: suspected.length > 0 ? suspected.join(" / ") : "No valid vote" });
      } else {
        output.createEl("h3", { text: result.isDraw ? "Draw" : result.winnerId ? "Winner" : "No winner" });
      }
    }
    if (result.keywordWolfReveal) output.createDiv({ cls: "discussion-hub-reveal", text: result.keywordWolfReveal });
    if (result.votes.length === 0 || result.activityMode === "keyword-wolf") return;
    if (result.finalConclusion) {
      const winner = output.createDiv({ cls: "discussion-hub-card is-winner" });
      this.renderMarkdown(winner, result.finalConclusion, 0);
    }
  }

  private waitForUserAction(output: HTMLElement, request: UserInputRequest, pendingPrompts: Set<() => void>): Promise<UserInputResponse> {
    return new Promise((resolve) => {
      const prompt = output.createDiv({ cls: "discussion-hub-user-action" });
      const label = request.type === "question"
        ? request.candidates?.length
          ? "Your turn: choose someone and ask a question"
          : `Your turn: ask ${request.targetDisplayName || "everyone else"}`
        : request.type === "answer"
          ? `Your turn: answer ${request.targetDisplayName || "the question"}`
          : request.type === "vote" ? "Your turn: vote" : "Your turn: respond";
      prompt.createSpan({ text: label });
      if (request.type === "answer" && request.question) {
        prompt.createEl("blockquote", { text: request.question });
      }
      const buttonText = request.type === "question" ? request.candidates?.length ? "Choose and ask" : "Ask"
        : request.type === "answer" ? "Answer"
          : request.type === "vote" ? "Vote" : "Respond";
      const open = prompt.createEl("button", { cls: "mod-cta", text: buttonText });
      let modal: UserInputModal | null = null;
      const settle = (value: UserInputResponse) => {
        pendingPrompts.delete(cancel);
        prompt.remove();
        resolve(value);
      };
      const cancel = () => { modal?.close(); settle({ content: "" }); };
      pendingPrompts.add(cancel);
      open.onclick = () => {
        open.disabled = true;
        modal = new UserInputModal(this.app, request, (value) => {
          if (value.cancelled) {
            open.disabled = false;
            return;
          }
          settle(value);
        });
        modal.open();
      };
    });
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
    return `${item.displayName}${id}`;
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
    this.titleEl.setText(
      this.request.type === "vote" ? `${this.request.displayName}: cast your vote`
        : this.request.type === "question" ? this.request.candidates?.length
          ? `${this.request.displayName}: choose someone to ask`
          : `${this.request.displayName}: ask ${this.request.targetDisplayName}`
          : this.request.type === "answer" ? `${this.request.displayName}: answer ${this.request.targetDisplayName}`
            : `${this.request.displayName}: your turn`,
    );
    if (this.request.type === "vote") {
      let selected = this.request.candidates?.[0]?.id || "";
      let reason = "";
      new Setting(this.contentEl).setName("Vote").addDropdown((dropdown) => {
        for (const candidate of this.request.candidates ?? []) dropdown.addOption(candidate.id, candidate.displayName);
        dropdown.onChange((value) => { selected = value; });
      });
      this.addResponseArea("Reason", (value) => { reason = value; });
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Submit vote").setCta().onClick(() => {
        this.settled = true; this.resolveInput({ content: "", votedForId: selected, reason }); this.close();
      }));
    } else {
      let content = "";
      let targetId = this.request.candidates?.[0]?.id;
      if (this.request.type === "answer" && this.request.question) {
        this.contentEl.createEl("blockquote", { text: this.request.question });
      }
      if (this.request.type === "question" && this.request.candidates?.length) {
        new Setting(this.contentEl).setName("Ask").addDropdown((dropdown) => {
          for (const candidate of this.request.candidates ?? []) dropdown.addOption(candidate.id, candidate.displayName);
          dropdown.onChange((value) => { targetId = value; });
        });
      }
      this.addResponseArea(this.request.role ? `Role: ${this.request.role}` : "Response", (value) => { content = value; });
      new Setting(this.contentEl).addButton((button) => button.setButtonText("Submit").setCta().onClick(() => {
        this.settled = true; this.resolveInput({ content, targetId }); this.close();
      }));
    }
  }

  private addResponseArea(name: string, onChange: (value: string) => void): void {
    new Setting(this.contentEl)
      .setClass("discussion-hub-user-input-setting")
      .setName(name)
      .addTextArea((text) => {
        text.inputEl.rows = 6;
        text.inputEl.addClass("discussion-hub-user-input");
        text.onChange(onChange);
      });
  }

  onClose(): void {
    if (!this.settled) this.resolveInput({ content: "", cancelled: true });
  }
}
