# Router — a small OpenRouter chat client

A single, dependency-free static site for chatting with any [OpenRouter](https://openrouter.ai)
model. No build step, no backend — it's three files and it runs anywhere that
can serve plain HTML, including GitHub Pages.

## Features

- **Any OpenRouter model** — type any model ID (e.g. `openai/gpt-4o-mini`,
  `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-8b-instruct:free`).
  The settings field also offers autocomplete from OpenRouter's live model list.
- **Streaming responses**, with a Stop button to cancel mid-generation
  (optional — can be turned off in Settings).
- **Permanent chats** — every conversation is saved to this browser's
  `localStorage` automatically and reloads exactly as you left it.
- **Multiple chats**, with search, rename, and delete.
- **Copying**: a per-message Copy button, a per-code-block Copy button, and a
  "Copy conversation" button that copies the whole thread as plain text.
- **Light / dark / system theme.**
- **Mobile-friendly** collapsible sidebar.
- Adjustable temperature, max tokens, and an optional system prompt.

## Using it

1. Open `index.html` (locally, or deployed — see below).
2. Click **Settings**, paste an OpenRouter API key
   (get one at [openrouter.ai/keys](https://openrouter.ai/keys)), and pick a
   model.
3. Start chatting.

Your API key and chats are stored **only in this browser's local storage**.
Nothing goes through any server but this page and openrouter.ai itself — API
calls are made directly from your browser to `https://openrouter.ai/api/v1`.
That also means the key is visible to anyone with access to this browser
profile, and chats don't sync between devices or browsers.

## Deploying to GitHub Pages

No build step is required.

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick your
   default branch and the `/ (root)` folder.
4. Save. GitHub will publish `index.html` at
   `https://<your-username>.github.io/<repo-name>/`.

## File layout

```
index.html            page structure
assets/css/styles.css  all styling (light + dark theme variables)
assets/js/app.js       storage, rendering, markdown, and the OpenRouter API client
```

## Notes on the Markdown rendering

Responses are rendered with a small, dependency-free Markdown subset: bold,
italics, inline code, fenced code blocks, links, headings, lists, and
blockquotes. It intentionally doesn't pull in a library like `marked.js`, to
keep the whole app to three files with no external runtime dependencies (a
CDN outage elsewhere on the web can't break this page). All model output is
HTML-escaped before any tag is introduced, so responses can't inject markup.
