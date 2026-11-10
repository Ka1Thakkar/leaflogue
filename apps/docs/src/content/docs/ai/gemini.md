---
title: The optional reading companion
description: Choose a provider, review what is sent, and keep an explanation as a note.
---

The desktop companion explains a passage you choose. It is off by default.
Turning it on does not send your library to a provider.

## Set up a provider

1. Open **Settings → Optional AI** and enable **AI features**.
2. Choose a provider and one of the models offered by your configuration.
3. Enter its API key, then choose **Save AI settings**. Saved keys stay in your
   [protected settings file](/start/files-and-settings/) and are not returned
   to the interface.

For Gemini, create a key in [Google AI Studio](https://aistudio.google.com/apikey).
You can instead set `GEMINI_API_KEY` before launching Leaflogue and leave the
saved-key field empty. Model availability, prices, and quotas depend on the
provider and your account; check the provider's current terms and usage limits.

Gemini's free-tier consent notice explains that what you send may be used to
improve Google's products. Read it before agreeing. A paid key or another
provider may have different terms.

## Explain a passage

Point at a passage, or focus its controls with <kbd>Tab</kbd>, then choose
**Explain this passage**. The side sheet opens and the explanation starts
right away.

The first time you use a provider, the sheet shows exactly what would be sent
before anything leaves your computer. Review it and choose **Send to** the
named provider. You won't be asked again for that provider.

The request includes the passage, title and authors, and any available book
series, publisher, and description. Your notes aren't sent. The prompt asks the
provider to avoid later-book spoilers, but an AI answer can still be wrong or
reveal more than you wanted.

## Ask follow-ups or save an answer

Answers scroll inside the side sheet. Type a question in the box at the bottom
to keep talking about the same passage. Questions that aren't about the
passage get a short refusal instead of an answer.

Choose **Save as note** under any answer to keep it beside the passage. The
note is labelled as AI-generated and becomes part of your library. Nothing
else from the conversation is saved, and closing the sheet stops a request
that is still running.

## Other providers and local servers

Leaflogue supports Anthropic, OpenAI, Gemini, and OpenAI-compatible providers.
The provider catalogue in the settings file supplies the visible models and
endpoints. See [`config.ai.example.json`](https://github.com/Ka1Thakkar/leaflogue/blob/main/config.ai.example.json)
for configuration examples, including compatible remote or local providers.
Do not paste your private key into a provider URL or a model name.

## In a self-hosted browser app

The person running the app supplies provider keys on the server or Convex
deployment. Readers choose from the available providers in Settings; browser
code does not receive those keys. See the [web hosting guides](/web/overview/).
The open-source web client uses the same explanation workflow.

## Turn it off

Disable **AI features** in Settings and save. Passage AI actions disappear,
and Leaflogue makes no AI requests while disabled. Notes you previously kept
remain in the library until you delete them.
