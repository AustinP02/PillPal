# PillPal

Medication tracker with webcam bottle scanning, reminders, daily check-ins, clinician-ready reports, and a clinical-trial finder.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # logic self-check
```

No `MONGODB_URI`? PillPal starts an embedded MongoDB that persists to `.data/db` (first run downloads it, about 1 minute).
For a real deploy, use MongoDB Atlas:

```bash
MONGODB_URI="mongodb+srv://..." NODE_ENV=production npm start
```

### AI (Google Gemini)
Put your key in `.env` (gitignored, loaded by `npm start`):

```
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-flash-latest   # optional
```

Gemini powers: photo label reading on Scan (falls back to on-device Tesseract OCR), the **Ask Pal** chatbot (knows the user's meds, adherence, check-ins and FDA label excerpts), "Explain it simply" drug explainers, Pal's note after each check-in, and AI visit prep on the doctor report.
Safety: Pal never gives dosing changes or diagnoses; emergency phrases always get a fixed 911 / Poison Help / 988 message even if the AI is down. Users can turn AI off in Settings. Busy errors retry, then fall back to `gemini-2.5-flash`.

Install as a desktop app from Chrome/Edge (Settings page, or browser menu → Install PillPal).

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Express API: auth (scrypt + httpOnly session cookies, login rate limit), meds, doses, check-ins, report, openFDA + ClinicalTrials.gov proxies |
| `logic.js` | Label OCR parsing and adherence/report math (tested by `test.js`) |
| `public/app.js` | The whole UI: Pal mascot, Today, Meds, Scan (webcam + Tesseract.js OCR overlay), Check-in, Doctor report, Trials, Settings, reminders |
| `public/styles.css` | Design tokens, light/dark themes, responsive layout, print styles for the report |
| `docs/brand-guidelines.md` | Voice, mascot, color, type, accessibility commitments |

## Data
Collections: `users`, `sessions` (TTL), `meds` (soft-deleted so history stays in reports), `doses` (unique per med/date/time), `checkins` (one per day).

## Known limits
- Reminders fire while PillPal is open (tab or installed app). Background push needs a service worker + push server.
- Bottle OCR works best with good light and a label that fills the frame; typing the name is the fallback.
- Drug info is summarized from openFDA labels. It is informational, not medical advice.
