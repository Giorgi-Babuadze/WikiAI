# Wikipedia Persona Chat

Paste a Wikipedia page for a public figure, generate a grounded persona with Gemini, and chat with that voice inside a React app.

## Recommended model

Use `gemini-2.5-flash`. It is the best fit here because it is fast, cheaper than Pro, and strong enough for biography-based conversational style generation.

## Setup

1. Copy `.env.example` to `.env`
2. Add your Google AI Studio key to `GEMINI_API_KEY`
3. Run `npm install`
4. Run `npm run dev`

The frontend starts on Vite and proxies `/api` requests to the local Node server on port `8787`.

## What the app does

- Accepts a Wikipedia URL like `https://en.wikipedia.org/wiki/Marie_Curie`
- Pulls biography text from Wikipedia
- Asks Gemini to create a persona profile from that source
- Lets the user chat with the persona while keeping replies grounded in the biography
