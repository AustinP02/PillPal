# PillPal Brand Guidelines

## Promise
**Your pills, remembered. Your story, ready for your doctor.**
PillPal helps people take medication on time, understand what they take, and walk into appointments with a clear, honest summary. It also points them toward clinical research and community health resources.

## Mascot: Pal
A two-tone capsule (coral top, cream bottom, navy outline) with big round eyes and stick arms.
Moods map to moments, never to judgement:

| Mood | When | Example line |
|---|---|---|
| `wave` | First run, empty states, reminders | "Hi, I'm Pal! Let's set up your first medication." |
| `happy` | Default, upcoming dose | "Next up: Lipitor at 8:00 PM." |
| `cheer` | All doses logged, scan matched, saved | "All done for today. Nice work!" |
| `concerned` | Overdue dose, flagged side effect, errors | "2 doses waiting for you." |
| `focus` | Searching / loading | "Searching ClinicalTrials.gov…" |

Pal never scolds, never diagnoses, and never gives dosing advice. Missed doses are stated plainly, with a next step.

## Voice
- **Warm, plain, short.** Aim for a 6th-grade reading level. One idea per sentence.
- **Say what to do next.** "Tap Taken once you've had it." Not "Dose overdue."
- **Honest about limits.** Information comes from FDA labels. The prescription label and the pharmacist come first. Emergencies: 911 and Poison Help (1-800-222-1222).
- **Avoid:** guilt ("You failed"), medical jargon without explanation, exclamation-heavy hype, emoji in clinical content.

## Color
| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | `#0B7A75` | `#43C7BC` | Primary actions, focus, progress |
| `--coral` | `#FF7A59` | same | Pal, due-now highlights (decorative, never body text) |
| `--sun` | `#FFC94D` | same | Streaks, partial days, study badges |
| `--ink` | `#10233A` | `#E9F2F1` | Text |
| `--ink-2` | `#48596B` | `#A8BCC3` | Secondary text |
| `--ok` / `--danger` | `#1D7F46` / `#B8322A` | `#6BD49A` / `#FF8A80` | Status (always paired with an icon or word) |

All text pairs meet WCAG 2.2 AA (4.5:1). Status is never shown by color alone.

## Type
- **Lexend** for headings. Designed for reading proficiency.
- **Atkinson Hyperlegible** for everything else. Designed by the Braille Institute for low-vision readers; distinct 0/O, 1/l/I.
- Base 17px; "Larger text" setting raises it to 21px. Never below 13px.

## Accessibility commitments
Grounded in W3C's older-users guidance and medication-adherence usability research (large fonts, simple layouts, voice prompts, confirm and undo):
- 44px+ touch targets; full keyboard support; visible focus rings; skip link.
- Settings for larger text, high contrast, reduced motion, light/dark theme, and spoken reminders.
- Every action has a clear confirmation (sound + toast + screen-reader announcement) and an Undo.
- Native `<dialog>`, labelled form fields, `aria-live` updates, charts with text alternatives.
- `prefers-reduced-motion` is respected automatically.

## Assets
- `public/icon.svg`: app icon (Pal on a teal tile).
- Pal is drawn in code (`pal()` in `public/app.js`) so it scales and themes without image files.
