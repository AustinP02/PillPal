# PillPal Brand Guidelines

## Promise
**Your pills, remembered. Your story, ready for your doctor.**
PillPal helps people take medication on time, understand what they take, and walk into appointments with a clear, honest summary. It also points them toward clinical research and community health resources. The brand should feel sleek, modern and a little playful, but never childish: people are often managing chronic conditions or caring for a parent, so calm, safe and trustworthy comes first.

## Mascot: Pip
An original two-tone capsule (lagoon top, apricot bottom) tilted −14°, with a minimal face on the warm half. Use at most one Pip per screen: onboarding, empty states, streaks and gentle alerts. Never next to clinical warnings.

| Mood | When | Example line |
|---|---|---|
| `happy` | Default, upcoming dose, first run | "Next up: Atorvastatin at 21:30." |
| `celebrate` | All doses logged, good week | "All done for today. Nice work." |
| `alert` | Dose due, flagged side effect, errors | "1 dose waiting for you." |
| `wink` | Thinking, searching, prompts | "Save today's check-in and I'll tell you what I'm noticing." |
| `sleepy` | Nothing found | "No recruiting studies matched." |

Pip never scolds, never diagnoses, and never gives dosing advice. Missed doses are stated plainly, with a next step.

## Voice
- **A calm, competent friend.** Warm and plain, about a 6th-grade reading level. Never clinical, never cutesy.
- **Sentence case everywhere.** Overlines are the only uppercase text. Buttons start with a verb: Take, Scan, Snooze, Add medication.
- **Say what to do next, without blame.** "Couldn't read that. Try a bit more light." Not "Recognition failure."
- **Honest about limits.** Information comes from FDA labels. The prescription label and the pharmacist come first. Emergencies: 911, Poison Help 1-800-222-1222, 988.
- **No emoji.** Pip carries the emotion. Celebrations are small and sincere: "Nice. That's 12 days in a row."
- Name + strength together ("Metformin · 500 mg"), times in mono (`8:00`, `21:30`), `·` as the separator.

## Color
| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` (Lagoon) | `#127479` | `#4DB9BB` | Primary actions, links, focus, progress |
| `--accent` (Apricot) | `#EE6F33` | `#FF9A63` | Streaks, avatar, Pip's lower half |
| `--status-taken` (Mint) | `#1F9D6B` | `#3CC48D` | Taken doses |
| `--status-due` (Honey) | `#E0A21B` | `#F2B83B` | Due now |
| `--status-missed` (Rose) | `#D64545` | `#F06A6A` | Missed doses, boxed warnings, emergencies only |
| `--bg-page` | `#F7F9F8` | `#0A1112` | Page background (never pure black) |

Status colors are always paired with a word or icon. No neon, no purple AI gradients.

## Type
- **Bricolage Grotesque**: headlines, big numbers, wordmark.
- **Figtree**: all UI and body text, 16px minimum body.
- **JetBrains Mono**: times only.

## Shape and motion
Cards 20px radius, dialogs and the scan frame 28px; buttons, badges, tags and tabs are full pills. Soft teal-tinted shadows. Springy presses (buttons scale to .97), a gentle Pip bob, and a sweeping scan line. "Reduce motion" turns all of it off.

## Accessibility commitments
44px minimum touch targets, visible 3px focus halos, skip link, live regions for dose logging and results, larger text and high contrast options, read-aloud reminders, and a printable doctor report.
