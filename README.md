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
3. Pick an **Activity**: Discussion, Riddle & mystery, or Keyword Wolf.
4. Enter a theme — or, in Keyword Wolf, choose random or custom keywords.
5. Add participants from any connected AI plugin, or add yourself.
6. Optionally assign roles and configure a separate set of voters.
7. Set the number of turns and click **Start discussion**.

You can also attach reference files to the discussion. Text references are included in the shared context, and attachments are passed to the connected models on the first turn. Attachments are not used in Keyword Wolf.

![Discussion in progress](docs/images/ai-discussion.png)

## Activities

| Activity | Flow | Voting |
| --- | --- | --- |
| Discussion | Turns → Conclusion → Voting | The configured voters pick the strongest conclusion |
| Riddle & mystery | Turns → Final answers | None; every answer is kept |
| Keyword Wolf | Question rounds → Voting | Every player votes, the wolf included |

### Discussion

1. **Discussion turns** — All participants respond in parallel. Each turn builds on the responses from earlier turns.
2. **Conclusion** — After the discussion turns, each participant provides a final conclusion.
3. **Voting** — The configured voters evaluate all conclusions and vote for the strongest one. With **Allow draw votes** enabled they can also vote for a draw.
4. **Result** — Discussion Hub announces a winner or draw. The complete transcript can be saved as a Markdown note.

Because everyone in a turn answers at the same time, a contribution is read from the *next* turn onwards. When you take part yourself, keep the turn count at 2 or more so the models actually see what you wrote.

![Saved discussion note](docs/images/ai-discussion-result.png)

### Riddle & mystery

A collaborative mode for riddles, mysteries, cases, situation puzzles, and logic problems. Participants examine the clues together, then each states a final answer with the reasoning behind it. There is no voting and no winner, so every answer is kept. The turn count defaults to 1.

### Keyword Wolf

A social deduction game. Every player is given a secret keyword; one randomly chosen player — the wolf — is given a slightly different one. Nobody is told which of the two they hold, not even the wolf, so the game is as much about realising you are the odd one out as it is about spotting someone else.

- Keywords come from 225 bundled pairs, or from a custom pair you type in.
- In each round every player asks a question and the others answer. When there is more than one round, the final round is a one-on-one interrogation: each player picks a single opponent to question.
- Every player votes for whoever they suspect, the wolf included, and may vote for themselves — naming yourself is how you claim you worked out that you are the wolf. The draw option does not apply.
- The wolf wins outright when it names itself and no other player names it. Being named by someone else makes a self-vote count for nothing, and the wolf loses once every other player names it. The verdict is shown with the reveal and kept in the saved note.
- The keywords and the wolf's identity are revealed once the vote is in, and are included in the saved note.
- Requires at least two participants. Voters are derived automatically, so the Vote participants list is not used.

![Keyword Wolf in progress](docs/images/keyword-wolf.png)

## Features

- **Cross-plugin participants** — Mix models supplied by LLM Hub, Gemini Helper, and Local LLM Hub in one discussion.
- **Activity modes** — Run a structured debate, solve a riddle together, or play Keyword Wolf with the same participant lineup.
- **Human participation** — Add yourself as a participant or voter. When it is your turn, a prompt appears in the transcript; open it to write your response, ask a question, answer one, or cast a vote. Stopping a run releases any prompt that is still waiting.
- **Role assignment** — Give each participant a perspective such as “Optimist” or “Skeptic.”
- **Separate voters** — Configure voters independently from discussion participants.
- **Live results** — Responses stream as they are written, and each vote appears as soon as that voter finishes rather than after all of them are in.
- **Draw votes** — Voters may declare a draw instead of choosing a side; turn it off to force a winner.
- **File attachments** — Add images, PDFs, text, audio, or video files up to 20 MB each.
- **Persistent configuration** — Participant and voter presets are restored across sessions.
- **Configurable prompts** — Customize the system, conclusion, and voting prompts, output folder, and default number of turns in the plugin settings.
- **Save as note** — Export the turns, conclusions, votes, and outcome as a Markdown file. Sections the activity did not produce are omitted, and a Keyword Wolf note keeps the reveal.

## Settings

Set the default number of turns, output folder, the prompts used for discussion, conclusions, and voting, and whether voters may **Allow draw votes** in the Discussion Hub settings.

![Discussion Hub settings](docs/images/ai-discussion-settings.png)

## Requirements

- Obsidian 1.10.0 or later
- At least one supported AI provider plugin, unless every participant and voter is human

## Integration contract

Providers register a `protocolVersion: 1` integration through the `discussion-hub:register-integration` workspace event and unregister the identical instance through `discussion-hub:unregister-integration`. Discussion Hub also emits `discussion-hub:ready`, so plugin load order does not matter.

The provider supplies `listModels()` and `streamText()`. Credentials and provider-specific settings stay inside the provider plugin.
