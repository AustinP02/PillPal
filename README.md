# PillPal

Medication tracker with webcam bottle scanning, reminders, daily check-ins, clinician-ready reports, and a clinical-trial finder.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # logic self-check
```

No `MONGODB_URI`? PillPal starts an embedded MongoDB (first run downloads it, about 1 minute). Its data lives outside the project folder, in `%LOCALAPPDATA%\PillPal\db` on Windows (`~/.local/share/PillPal/db` on Linux, `~/Library/Application Support/PillPal/db` on Mac), because cloud-synced folders like OneDrive lock the database files and crash it. Override with `PILLPAL_DB_DIR`. Data from the old `.data/db` is copied over once. If the database stops anyway, the server restarts it and logs why.
For a real deploy, use MongoDB Atlas:

```bash
MONGODB_URI="mongodb+srv://..." NODE_ENV=production npm start
```

### AI (Google Gemini)
Put your key in `.env` (gitignored, loaded by `npm start`):

```
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.8-flash   # optional (this is the default): chat, explainers, visit prep, dose timing
GEMINI_SCAN_MODEL=gemini-3.5-flash-lite   # optional: label reading (fast model, minimal thinking)
```

Gemini powers: photo label reading on Scan (falls back to on-device Tesseract OCR), the **Ask Pip** chatbot (knows the user's meds, adherence, check-ins and FDA label excerpts), "Explain it simply" drug explainers, Pip's note after each check-in, and AI visit prep on the doctor report.
Safety: Pip never gives dosing changes or diagnoses; emergency phrases always get a fixed 911 / Poison Help / 988 message even if the AI is down. Users can turn AI off in Settings. Busy or unavailable models retry, then fall back to `gemini-3.6-flash` and `gemini-3.5-flash-lite` (2.5 models are restricted to older accounts, so they aren't used). No temperature is sent (Gemini 3.6+ ignores it and newer models reject it).

Chat replies stream in as they're written (`/api/ai/chat/stream`, Flash-Lite with minimal thinking first), and what Pip knows about you is prepared when Ask Pip opens and reused for a minute.

Is it working? On start the server logs `Gemini: key works, using …` or `Gemini check FAILED: …`, and **Settings → Pip's AI** shows the same. Keys from AI Studio now start with `AQ.`; they work here (sent in the `x-goog-api-key` header). If Google rejects the key, every AI feature says so plainly instead of a generic error.

Install as a desktop app from Chrome/Edge (Settings page, or browser menu → Install PillPal).

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Express API: auth (scrypt + httpOnly session cookies, login rate limit), meds, doses, check-ins, report, openFDA + ClinicalTrials.gov proxies, Gemini |
| `logic.js` | Label OCR parsing and adherence/report math (tested by `test.js`) |
| `public/app.js` | The whole UI: Today, My cabinet, Scan (webcam + Tesseract.js OCR), Check-in, Ask Pip, Doctor report, Trials, Settings, reminders |
| `public/ui.js` | Design-system primitives as HTML helpers: Button, Badge, Tag, Pill, Pip mascot, Logo, ProgressRing, Input, Select, Switch, Tabs |
| `public/ds/` | PillPal design system tokens and component classes (`colors`, `typography`, `spacing`, `base`, `components`) |
| `public/styles.css` | App layout on top of the design system: sidebar, phone tab bar, screens, print styles for the report |
| `public/icons.js` | Vendored Lucide 0.460 icons (no icon CDN needed) |
| `docs/brand-guidelines.md` | Voice, Pip, color, type, accessibility commitments |

### Design system
Themes: **Light**, **Warm** (cream and apricot) and **Dark**, from the theme button in the header or Settings (`[data-theme]` tokens in `public/ds/colors.css`).
The UI follows the PillPal design system: Lagoon teal for trust and primary actions, Apricot for warmth, status colors that always come with a word or icon (taken = mint, due = honey, missed = rose), Bricolage Grotesque headlines, Figtree body text, JetBrains Mono for times. Light and dark themes (`data-theme` on `<html>`), larger text, high contrast and reduced motion are all in Settings. Below 820px wide the sidebar becomes a bottom tab bar with a "More" sheet.

## How scanning works
1. **Camera + quality gate** (`public/scanner.js`): 4 times a second the app checks the frame for light, blur (variance of the Laplacian) and glare, and says what to fix. Read-aloud users hear the hints.
2. **Barcode** (bundled ZXing reader in `public/vendor/`, native `BarcodeDetector` where available): UPC-A / EAN-13 stock bottles and DSCSA Data Matrix codes give an exact NDC (plus lot and expiry).
3. **Auto-scan** captures once the frame has been clear for ~0.75 s (max 3 tries a minute, only on a new view). **Start scan** always works; **Use a photo** opens the phone camera app.
4. **Reading:** Pip (Gemini, strict JSON schema) reads only the area inside the frame. Fallback: Tesseract.js on the device with adaptive thresholding; an unsure read gets a second look and must agree.
5. **Matching** (`server.js`): NDC via openFDA, names via RxNorm `approximateTerm` (spelling-tolerant, free, cached), then the FDA label. Close runners-up are offered as "Did you mean"; a pick is remembered per user (`scanfixes`).
6. **Cross-checks:** NDC vs name, strength vs RxNorm's known strengths. Then duplicates (same ingredient already tracked), open FDA recalls (lot-aware), and label text that names the user's other meds.
7. **Label extras:** directions become suggested reminder times (`parseSig` in `logic.js`), quantity / refills / fill date / discard-after feed run-out and discard reminders on Today.

Speed: label reading uses a fast Flash-Lite model with minimal "thinking" and falls back to `GEMINI_MODEL` (low thinking) if your key can't use it. RxNorm/openFDA lookups run in parallel and are cached; the on-device reader starts in the background when the Scan page opens with AI off. The server logs `scan timing: Gemini read … ms · drug match + checks … ms` and the browser console logs `[scan] …` per step.

Gate thresholds are starting points. Tune them on your demo webcam: in the browser console run `localStorage.setItem('pp-scandebug','1')` and the status pill shows live light / sharpness / glare numbers (`GATE` in `public/scanner.js`).

AI note: Google AI Pro subscriptions don't change the Gemini API tier; an API key is on free-tier terms unless its project has Cloud Billing enabled.

## Dose timers, cabinet and mix check
- **Dose timers (Today):** a med shows up under "Until your next dose" only after it's taken. **Take** (from the schedule, the timer, or "Take a dose now" on a bottle in My cabinet for doses not on today's list) starts a countdown as long as the gap between doses. Pip (Gemini) works that gap out once per med from the user's directions, reminder times and the FDA label's dosing (`POST /api/meds/intervals`, stored as `interval`); without AI it falls back to the directions ("every 6 hours", "twice daily": `hoursFromDirections` in `logic.js`), then the reminder times. A number typed in "Hours between doses" always wins. **Undo** removes the timer until the next Take. When a timer runs out and a dose is still left today, the card offers **Take**, **Skip** or **Remind me in _x_ min** (same in the reminder pop-up). **Skip** never starts a timer.
- **Quick check-in:** right after a dose, PillPal offers "How do you feel?" for that medicine (mood, side effects, note). These go in `medcheckins`, on the doctor report ("How each medication feels") and into Pip's context.
- **My cabinet:** each med is a flat, Pip-style bottle on a shelf: an amber pill bottle with a ridged white cap (pills in the med's colour show at the bottom), or an amber syrup bottle with a dosing cup for liquids (`form`: picked in the med form, inferred from "mL"/"suspension" etc., or from the scanned label). Tap one for details, Ask Pip, Edit, **Stop tracking** (keeps history) or **Remove** (deletes the med, its doses and check-ins).
- **Pip's mix check:** `GET /api/meds/mixes` compares every pair of your meds against their FDA labels (drug interactions, "Ask a doctor or pharmacist", "Do not use"), matching names and drug classes ("NSAIDs", "blood thinners", see `mixNames` in `logic.js`). The label quote is always shown; with AI on, Pip adds one plain-language line per pair. Labels that say "contraindicated / do not / avoid" are marked **Label says avoid**, others **Take care together**. It never tells anyone to stop a medicine.

## Health log, studies and trial matching
- **Health log** (sidebar): blood pressure and pulse, weight, blood sugar (with fasting / after a meal), temperature, oxygen, pain (0 to 10) and A1C, each with a trend line and gentle flags from common adult ranges (`vitalFlag` in `logic.js`; very high or low readings show what to do and when to call 911). **Side effects in detail**: start and stop dates, mild / moderate / severe, which medicine might be causing it, and whether it led to an ER visit, a hospital stay or a stopped medicine (serious ones are flagged, with the study team's number when a study drug is suspected). Both appear on the doctor report, in Pip's context and in visit prep.
- **My studies** (Trials page): study ID checked against ClinicalTrials.gov (title and status), participant ID, site, coordinator with Call / Email, visit dates (the next one within a week shows on Today), and **Send to my study team**: the last 30 days of study-drug doses, side effects, measurements and notes, ready to email, copy or print.
- **About you**: birth year, sex, location and conditions. Search results show each study's age and sex rules and flag ones that clearly don't fit; **Pip pre-check** reads a study's eligibility criteria against your profile, meds and measurements (likely / maybe / unlikely, with what to ask the study team).
- **Trial links**: study pages link to `https://clinicaltrials.gov/study/NCT…`. ClinicalTrials.gov's firewall refuses some server HTTP clients, so the server tries `fetch`, then `node:https`; if both are refused, the browser calls the API itself, and every search also links to the same search on the ClinicalTrials.gov website. The browser shares `logic.js` (served at `/logic.js`) for this.

## Demo mode
**Try the demo** on the sign-in screen (or **Settings → Demo mode**) opens a separate demo account filled with a 60-day story (`demo.js`), so every feature has something to show:
- 9 meds in My cabinet: round, oval and capsule pills in different colours, two syrups (amoxicillin, guaifenesin), the study drug orforglipron in the real ACHIEVE-1 trial (NCT05971940, with sample participant ID, coordinator and visits), and two pairs with mixing warnings.
- Measurements: blood pressure and fasting sugar coming down, weight down about 8 lb, one low sugar, a fever with the ear infection, knee pain scores and two A1C results; side effects in detail (nausea from the study drug, upset stomach from amoxicillin).
- Dose history at ~93% with weekend-evening slips, a rough week 5 weeks back, and a 9-day streak; refill and discard-after notes.
- Check-ins with headaches after the study drug started and an upset stomach since the antibiotic (flagged on the report), notes and questions for the doctor, and per-medicine check-ins.
- Live on Today: Advil's timer comes due about 2 minutes after the demo opens, lisinopril is snoozed, others count down.
- Pip's chat (streamed), explanations, check-in note, visit summary and mix check are pre-written, so the demo never waits on Gemini. Label scanning still reads for real.
**Reset demo** (banner or Settings) rebuilds the story for the current time; **Exit demo** signs out. Demo accounts can't sign in with a password and are deleted after a day.

## Data
Collections: `users` (plus `profile` and `studies`), `vitals`, `effects`, `sessions` (TTL), `meds` (soft-deleted so history stays in reports; RxNorm ingredients, refill fields, `form`, `interval`, `timer`, `snooze`), `doses` (unique per med/date/time), `checkins` (one per day), `medcheckins` (how a med feels, after a dose), `scanfixes` (per-user scan corrections).

## Known limits
- Reminders fire while PillPal is open (tab or installed app). Background push needs a service worker + push server.
- Bottle OCR works best with good light and a label that fills the frame; typing the name is the fallback.
- Drug info is summarized from openFDA labels. It is informational, not medical advice.
