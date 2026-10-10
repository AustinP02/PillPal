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
GEMINI_MODEL=gemini-flash-latest   # optional: chat, explainers, visit prep
GEMINI_SCAN_MODEL=gemini-3.5-flash-lite   # optional: label reading (fast model, minimal thinking)
```

Gemini powers: photo label reading on Scan (falls back to on-device Tesseract OCR), the **Ask Pip** chatbot (knows the user's meds, adherence, check-ins and FDA label excerpts), "Explain it simply" drug explainers, Pip's note after each check-in, and AI visit prep on the doctor report.
Safety: Pip never gives dosing changes or diagnoses; emergency phrases always get a fixed 911 / Poison Help / 988 message even if the AI is down. Users can turn AI off in Settings. Busy errors retry, then fall back to `gemini-2.5-flash`.

Install as a desktop app from Chrome/Edge (Settings page, or browser menu → Install PillPal).

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Express API: auth (scrypt + httpOnly session cookies, login rate limit), meds, doses, check-ins, report, openFDA + ClinicalTrials.gov proxies, Gemini |
| `logic.js` | Label OCR parsing and adherence/report math (tested by `test.js`) |
| `public/app.js` | The whole UI: Today, My meds, Scan (webcam + Tesseract.js OCR), Check-in, Ask Pip, Doctor report, Trials, Settings, reminders |
| `public/ui.js` | Design-system primitives as HTML helpers: Button, Badge, Tag, Pill, Pip mascot, Logo, ProgressRing, Input, Select, Switch, Tabs |
| `public/ds/` | PillPal design system tokens and component classes (`colors`, `typography`, `spacing`, `base`, `components`) |
| `public/styles.css` | App layout on top of the design system: sidebar, phone tab bar, screens, print styles for the report |
| `public/icons.js` | Vendored Lucide 0.460 icons (no icon CDN needed) |
| `docs/brand-guidelines.md` | Voice, Pip, color, type, accessibility commitments |

### Design system
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

## Data
Collections: `users`, `sessions` (TTL), `meds` (soft-deleted so history stays in reports; RxNorm ingredients + refill fields), `doses` (unique per med/date/time), `checkins` (one per day), `scanfixes` (per-user scan corrections).

## Known limits
- Reminders fire while PillPal is open (tab or installed app). Background push needs a service worker + push server.
- Bottle OCR works best with good light and a label that fills the frame; typing the name is the fallback.
- Drug info is summarized from openFDA labels. It is informational, not medical advice.
