// PillPal feature catalog for Debug Station. Shared by the server (request tagging) and the browser
// (client telemetry + the /debug UI). Keep ids stable: they are stored with every log event.

export const FEATURES = {
  'auth.signup':    { group: 'Account', label: 'Sign up' },
  'auth.login':     { group: 'Account', label: 'Sign in', hint: '8 failed tries per email + IP locks for 15 min' },
  'auth.logout':    { group: 'Account', label: 'Sign out' },
  'account':        { group: 'Account', label: 'Profile & settings', hint: 'GET/PATCH /api/me, accessibility prefs, AI opt-out' },
  'meds':           { group: 'Medications', label: 'My meds', hint: 'Add / edit / soft-delete medications' },
  'doses':          { group: 'Medications', label: 'Dose logging', hint: 'Taken / skipped / reset on Today' },
  'reminders':      { group: 'Medications', label: 'Reminders', client: true, hint: '15 s tick in the open tab, chime, voice, desktop notification, snooze' },
  'checkins':       { group: 'Medications', label: 'Daily check-in', hint: 'Mood, side effects, notes' },
  'report':         { group: 'Medications', label: 'Doctor report', hint: 'Adherence math from logic.js' },
  'scan.camera':    { group: 'Scan & drug info', label: 'Camera', client: true, hint: 'getUserMedia permission and stream' },
  'scan.ai':        { group: 'Scan & drug info', label: 'AI label reader', hint: 'Gemini vision → openFDA match' },
  'scan.ocr':       { group: 'Scan & drug info', label: 'Basic label reader', hint: 'Tesseract.js in the browser → /api/drug/scan' },
  'drug-info':      { group: 'Scan & drug info', label: 'Drug lookup (openFDA)', hint: 'Typed lookups and label facts' },
  'ai.chat':        { group: 'Pal AI', label: 'Ask Pal chat', hint: 'Gemini with patient context; emergency phrases get a fixed safety message' },
  'ai.explain':     { group: 'Pal AI', label: 'Explain it simply' },
  'ai.insight':     { group: 'Pal AI', label: "Pal's check-in note" },
  'ai.visit-prep':  { group: 'Pal AI', label: 'Visit prep' },
  'trials':         { group: 'Research', label: 'Trial finder', hint: 'ClinicalTrials.gov v2 API' },
  'ui':             { group: 'App', label: 'App shell & pages', client: true, hint: 'Page views, JS errors, install prompt' },
  'static':         { group: 'App', label: 'Static files' },
  'system':         { group: 'App', label: 'Server & database', hint: 'Startup, MongoDB, uncaught errors' },
};

// Route → feature. Order matters: first match wins.
const ROUTES = [
  [/^\/api\/signup$/, 'auth.signup'], [/^\/api\/login$/, 'auth.login'], [/^\/api\/logout$/, 'auth.logout'],
  [/^\/api\/me$/, 'account'], [/^\/api\/meds/, 'meds'], [/^\/api\/doses/, 'doses'], [/^\/api\/checkins/, 'checkins'],
  [/^\/api\/report/, 'report'], [/^\/api\/drug\/scan/, 'scan.ocr'], [/^\/api\/drug/, 'drug-info'], [/^\/api\/trials/, 'trials'],
  [/^\/api\/ai\/scan/, 'scan.ai'], [/^\/api\/ai\/chat/, 'ai.chat'], [/^\/api\/ai\/explain/, 'ai.explain'],
  [/^\/api\/ai\/insight/, 'ai.insight'], [/^\/api\/ai\/visit-prep/, 'ai.visit-prep'], [/^\/api\//, 'system'],
];
export const featureOf = path => (ROUTES.find(([re]) => re.test(path)) || [, 'static'])[1];

// Replace ids in a route so paths group together and don't leak record ids into summaries.
export const routeOf = path => path.split('?')[0].replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id');
