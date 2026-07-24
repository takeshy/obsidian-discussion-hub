import { Plugin, PluginSettingTab, Setting, TFile, normalizePath, type EventRef } from "obsidian";
import { DiscussionEngine } from "./discussionEngine";
import { DiscussionView, DISCUSSION_VIEW_TYPE } from "./view";
import { integrationContractErrors, shouldUnregisterIntegration, type DiscussionIntegrationUnregisterRequest } from "./integrationContract";
import { mergeLegacySettings } from "./legacyMigration";
import {
  DEFAULT_SETTINGS,
  type DiscussionAttachment,
  type DiscussionHubSettings,
  type DiscussionModel,
  type DiscussionParticipant,
  type DiscussionProviderIntegration,
  type DiscussionResult,
  type DiscussionVoter,
  type OpenDiscussionRequest,
  type RunDiscussionRequest,
} from "./types";

export interface RegisteredDiscussionModel extends DiscussionModel {
  providerId: string;
  providerName: string;
}

export interface DiscussionHubApi {
  registerIntegration: (integration: DiscussionProviderIntegration) => () => void;
  openDiscussion: (request?: OpenDiscussionRequest) => Promise<void>;
  runDiscussion: (request: RunDiscussionRequest) => Promise<DiscussionResult>;
  getConfiguration: () => { defaultTurns: number; participants: DiscussionParticipant[]; voters: DiscussionVoter[] };
}

export default class DiscussionHubPlugin extends Plugin implements DiscussionHubApi {
  settings: DiscussionHubSettings = { ...DEFAULT_SETTINGS };
  private readonly integrations = new Map<string, DiscussionProviderIntegration>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.registerView(DISCUSSION_VIEW_TYPE, (leaf) => new DiscussionView(leaf, this));
    this.addRibbonIcon("messages-square", "Open Discussion Hub", () => void this.openDiscussion());
    this.addCommand({ id: "open-discussion", name: "Open discussion", callback: () => void this.openDiscussion() });
    this.addSettingTab(new DiscussionHubSettingTab(this));
    this.registerIntegrationEvents();
    window.setTimeout(() => this.announceReady(), 0);
    this.app.workspace.onLayoutReady(() => {
      this.announceReady();
      // Some providers load their saved model settings asynchronously.
      window.setTimeout(() => this.announceReady(), 1000);
    });
  }

  onunload(): void {
    this.integrations.clear();
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Partial<DiscussionHubSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(loaded ?? {}),
      participants: loaded?.participants ?? [],
      voters: loaded?.voters ?? [],
      importedLegacyProviders: loaded?.importedLegacyProviders ?? [],
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  registerIntegration(integration: DiscussionProviderIntegration): () => void {
    const errors = integrationContractErrors(integration);
    if (errors.length > 0) {
      console.warn(`Discussion Hub: invalid provider ${integration.id || "(unknown)"}: ${errors.join(", ")}`);
      return () => undefined;
    }
    this.integrations.set(integration.id, integration);
    void this.importLegacySettings(integration);
    this.refreshViews();
    return () => {
      if (this.integrations.get(integration.id) === integration) {
        this.integrations.delete(integration.id);
        this.refreshViews();
      }
    };
  }

  unregisterIntegration(request: DiscussionIntegrationUnregisterRequest): boolean {
    if (!request.id) return false;
    const current = this.integrations.get(request.id);
    if (!shouldUnregisterIntegration(current, request)) return false;
    const removed = this.integrations.delete(request.id);
    if (removed) this.refreshViews();
    return removed;
  }

  getProvider(id: string): DiscussionProviderIntegration | undefined {
    return this.integrations.get(id);
  }

  async listModels(): Promise<RegisteredDiscussionModel[]> {
    const entries = await Promise.all([...this.integrations.values()].map(async (integration) => {
      try {
        return (await integration.listModels()).map((model) => ({ ...model, providerId: integration.id, providerName: integration.name }));
      } catch (error) {
        console.warn(`Discussion Hub: failed to list ${integration.name} models`, error);
        return [];
      }
    }));
    return entries.flat();
  }

  getConnectedProviderNames(): string[] {
    return [...this.integrations.values()].map((integration) => integration.name);
  }

  requestProviderRegistration(): void {
    this.announceReady();
  }

  async openDiscussion(request: OpenDiscussionRequest = {}): Promise<void> {
    // Re-announce whenever the view is opened so already-running providers can
    // recover even if their initial registration happened before Hub loaded.
    this.announceReady();
    let leaf = this.app.workspace.getLeavesOfType(DISCUSSION_VIEW_TYPE)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: DISCUSSION_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof DiscussionView) view.setDraft(request);
  }

  createEngine(attachments: DiscussionAttachment[] = []): DiscussionEngine {
    return new DiscussionEngine((id) => this.integrations.get(id), this.settings, {
      attachments,
      referenceContext: this.referenceContext(attachments),
    });
  }

  async runDiscussion(request: RunDiscussionRequest): Promise<DiscussionResult> {
    const engine = this.createEngine(request.attachments);
    const stop = () => engine.stop();
    request.abortSignal?.addEventListener("abort", stop, { once: true });
    try {
      return await engine.run(
      request.theme?.trim() || "",
      request.turns ?? this.settings.defaultTurns,
      request.participants ?? this.settings.participants,
      request.voters ?? this.settings.voters,
      );
    } finally {
      request.abortSignal?.removeEventListener("abort", stop);
    }
  }

  getConfiguration(): { defaultTurns: number; participants: DiscussionParticipant[]; voters: DiscussionVoter[] } {
    return {
      defaultTurns: this.settings.defaultTurns,
      participants: this.settings.participants.map((item) => ({ ...item })),
      voters: this.settings.voters.map((item) => ({ ...item })),
    };
  }

  async updateParticipants(participants: DiscussionParticipant[], voters: DiscussionVoter[]): Promise<void> {
    this.settings.participants = participants;
    this.settings.voters = voters;
    await this.saveSettings();
  }

  async saveResult(result: DiscussionResult): Promise<TFile> {
    const folder = normalizePath(this.settings.outputFolder.trim() || "discussions");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const base = result.theme.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Discussion";
    let path = normalizePath(`${folder}/${base}.md`);
    for (let index = 2; this.app.vault.getAbstractFileByPath(path); index += 1) path = normalizePath(`${folder}/${base} ${index}.md`);
    return this.app.vault.create(path, DiscussionEngine.toMarkdown(result));
  }

  private referenceContext(attachments: DiscussionAttachment[]): string {
    const decoded = attachments.filter((item) => item.type === "text" || item.mimeType.startsWith("text/"))
      .map((item) => {
        try { return decodeURIComponent(escape(atob(item.data))); } catch { return atob(item.data); }
      });
    return decoded.length > 0 ? `# Reference materials\n\n${decoded.join("\n\n---\n\n")}` : "";
  }

  private async importLegacySettings(integration: DiscussionProviderIntegration): Promise<void> {
    if (!integration.getLegacyDiscussionSettings || this.settings.importedLegacyProviders.includes(integration.id)) return;
    try {
      const legacy = await integration.getLegacyDiscussionSettings();
      if (!legacy) return;
      if (this.settings.participants.length === 0 && this.settings.voters.length === 0) {
        this.settings = mergeLegacySettings(this.settings, integration.id, legacy);
      }
      this.settings.importedLegacyProviders.push(integration.id);
      await this.saveSettings();
      this.refreshViews();
    } catch (error) {
      console.warn(`Discussion Hub: could not import settings from ${integration.name}`, error);
    }
  }

  private registerIntegrationEvents(): void {
    const workspace = this.app.workspace as unknown as {
      on: {
        (name: "discussion-hub:register-integration", callback: (value: DiscussionProviderIntegration) => void): EventRef;
        (name: "discussion-hub:unregister-integration", callback: (value: DiscussionIntegrationUnregisterRequest) => void): EventRef;
      };
    };
    this.registerEvent(workspace.on("discussion-hub:register-integration", (value) => this.registerIntegration(value)));
    this.registerEvent(workspace.on("discussion-hub:unregister-integration", (value) => this.unregisterIntegration(value)));
  }

  private announceReady(): void {
    const workspace = this.app.workspace as unknown as { trigger: (name: string, api: DiscussionHubApi) => void };
    workspace.trigger("discussion-hub:ready", this);
  }

  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DISCUSSION_VIEW_TYPE)) {
      if (leaf.view instanceof DiscussionView) void leaf.view.render();
    }
  }
}

class DiscussionHubSettingTab extends PluginSettingTab {
  constructor(private readonly discussionPlugin: DiscussionHubPlugin) {
    super(discussionPlugin.app, discussionPlugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.addClass("discussion-hub-settings");
    new Setting(this.containerEl).setName("Default turns").addText((text) => text
      .setValue(String(this.discussionPlugin.settings.defaultTurns))
      .onChange(async (value) => {
        this.discussionPlugin.settings.defaultTurns = Math.max(1, Math.min(20, Number(value) || 2));
        await this.discussionPlugin.saveSettings();
      }));
    new Setting(this.containerEl).setName("Output folder").addText((text) => text
      .setValue(this.discussionPlugin.settings.outputFolder)
      .onChange(async (value) => { this.discussionPlugin.settings.outputFolder = value; await this.discussionPlugin.saveSettings(); }));
    for (const [key, name] of [["systemPrompt", "System prompt"], ["conclusionPrompt", "Conclusion prompt"], ["votePrompt", "Vote prompt"]] as const) {
      new Setting(this.containerEl)
        .setClass("discussion-hub-prompt-setting")
        .setName(name)
        .addTextArea((text) => {
          text.inputEl.addClass("discussion-hub-prompt-input");
          text
            .setValue(this.discussionPlugin.settings[key])
            .onChange(async (value) => { this.discussionPlugin.settings[key] = value; await this.discussionPlugin.saveSettings(); });
        });
    }
    if (this.discussionPlugin.settings.participants.length === 0) {
      this.containerEl.createEl("p", { text: "Participants are configured in the Discussion Hub view after an AI provider connects." });
    }
  }
}
