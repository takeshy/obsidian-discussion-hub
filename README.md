# Obsidian Discussion Hub

[日本語](README_ja.md)

Discussion Hub provides a shared multi-model discussion UI and orchestration for Obsidian. AI plugins connect at runtime and contribute their available text models, so models from different providers can participate in the same structured discussion.

Supported integrations in this workspace:

- [LLM Hub](https://github.com/takeshy/obsidian-llm-hub)
- [Gemini Helper](https://github.com/takeshy/obsidian-gemini-helper)
- [Local LLM Hub](https://github.com/takeshy/obsidian-local-llm-hub)

![Discussion setup](docs/images/ai-discussion-start.png)

## How to use

1. Install and enable Discussion Hub. Enable at least one supported AI provider plugin when you want AI models to participate.
2. Open Discussion Hub from its ribbon icon or run **Discussion Hub: Open discussion** from the command palette.
3. Enter a discussion theme.
4. Add participants from any connected AI plugin, or add yourself.
5. Optionally assign roles and configure a separate set of voters.
6. Set the number of turns and click **Start discussion**.

You can also attach reference files to the discussion. Text references are included in the shared context, and attachments are passed to the connected models on the first turn.

![Discussion in progress](docs/images/ai-discussion.png)

## Discussion flow

1. **Discussion turns** — All participants respond in parallel. Each turn builds on the responses from earlier turns.
2. **Conclusion** — After the discussion turns, each participant provides a final conclusion.
3. **Voting** — The configured voters evaluate all conclusions and vote for the strongest one.
4. **Result** — Discussion Hub announces a winner or draw. The complete transcript can be saved as a Markdown note.

![Saved discussion note](docs/images/ai-discussion-result.png)

## Features

- **Cross-plugin participants** — Mix models supplied by LLM Hub, Gemini Helper, and Local LLM Hub in one discussion.
- **Human participation** — Add yourself as a participant or voter for human-in-the-loop discussions.
- **Role assignment** — Give each participant a perspective such as “Optimist” or “Skeptic.”
- **Separate voters** — Configure voters independently from discussion participants.
- **File attachments** — Add images, PDFs, text, audio, or video files up to 20 MB each.
- **Persistent configuration** — Participant and voter presets are restored across sessions.
- **Configurable prompts** — Customize the system, conclusion, and voting prompts, output folder, and default number of turns in the plugin settings.
- **Save as note** — Export the turns, conclusions, votes, and winning conclusion as a Markdown file.

## Settings

Set the default number of turns, output folder, and the prompts used for discussion, conclusions, and voting in the Discussion Hub settings.

![Discussion Hub settings](docs/images/ai-discussion-settings.png)

## Requirements

- Obsidian 1.10.0 or later
- At least one supported AI provider plugin, unless every participant and voter is human

## Integration contract

Providers register a `protocolVersion: 1` integration through the `discussion-hub:register-integration` workspace event and unregister the identical instance through `discussion-hub:unregister-integration`. Discussion Hub also emits `discussion-hub:ready`, so plugin load order does not matter.

The provider supplies `listModels()` and `streamText()`. Credentials and provider-specific settings stay inside the provider plugin.
