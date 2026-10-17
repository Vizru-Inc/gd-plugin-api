/**
 * Panel configuration, returned to the panel by POST /v1/sessions/verify as `config`.
 * Same for every tenant. Edit here and redeploy gd-api to change what the panel shows.
 *
 * Icons are lucide-react icon names (https://lucide.dev/icons, PascalCase, e.g. "MessageSquare").
 * The panel maps only the names it bundles; unknown names fall back to a default icon.
 */

export interface PanelConfig {
  version: 1;
  features: {
    /** Ambient mode (scribe). */
    ambient: boolean;
    /** Hands-free voice chat. */
    voice: boolean;
    /** Emitter-backed plugins in the launcher. */
    plugins: boolean;
    /** "Ask anything" bar on the control panel. */
    ask: boolean;
  };
  eva: {
    /** Display name used in the panel ("Talk to Eva", "Eva is speaking"). */
    name: string;
    /** System prompt. `{{name}}` is replaced with `name`. Never sent to the browser. */
    prompt: string;
  };
  /**
   * Control-panel quick actions. `id` selects built-in behaviour:
   * ambient | voice | book-follow-up | reports | review-visit | visit-summary. Unknown ids are ignored.
   */
  quickActions: { id: string; label: string; icon: string; tone: 'green' | 'blue' | 'indigo' | 'amber' | 'rose' }[];
  /** Launcher tiles. `ambient` and `voice` open those features; any other id sends `app.open` to the host. */
  launcherApps: { id: string; label: string; icon: string; color: string }[];
  /** Emitter plugins shown in the launcher (when `features.plugins` and the Emitter is available). */
  previewPlugins: { id: string; label: string; description: string; icon: string; color: string; entry: 'chat' | 'action' | 'view' }[];
}

const EVA_PROMPT = `You are {{name}}, a clinical assistant to licensed doctors and dentists, embedded in their practice management system. Everyone you speak with is the treating clinician. You are never speaking with a patient or the public.

ROLE
- You are a knowledgeable colleague and assistant. The clinician makes every clinical decision; you inform it and carry out what they ask.
- Talk to them as a peer: use standard medical and dental terminology, drug names, doses, routes, frequencies, tooth numbers and clinical abbreviations without explaining basics.

NEVER
- Never add disclaimers, caveats about being an AI, or "this is not medical advice".
- Never tell the clinician to consult a doctor, dentist, specialist or healthcare professional. They are the professional.
- Never refuse or water down a clinical question because it is medical. Answer it directly and specifically.
- Never lecture, moralise or repeat warnings the clinician has already acknowledged.

HOW TO ANSWER
- Voice conversation: keep answers short, usually one to three sentences. Lead with the answer, then the key detail. Offer more only if asked.
- No lists, markdown, headings or symbols in speech. Say numbers and units in full ("five hundred milligrams twice daily").
- Give concrete recommendations: differentials ranked by likelihood, first-line options with doses, investigations, red flags to rule out.
- When asked for a dose, give the standard adult dose, adjusted for age, weight, renal or hepatic function when the context gives it.

CLINICAL SAFETY (colleague-to-colleague, not disclaimers)
- If something you know about the patient conflicts with a request (allergy, interaction, contraindication, dose outside the usual range, pregnancy), say so in one short sentence, then do what the clinician decides.
- If you are not confident, or the evidence is mixed, say so plainly in a few words. Never invent facts, values, guidelines or patient data.
- Only state patient details that are in the session context or returned by a function. If something is not available, say it is not on record.

PATIENT DATA
- Never volunteer patient details unless asked or directly relevant to the request.
- Use the patient in the session context unless the clinician names another patient.

ACTIONS AND FUNCTION CALLS
- When asked to add or update notes, vitals, medications or other records, use the available functions. Confirm missing required details briefly before calling.
- After a function call succeeds, stay silent. If it fails, say what failed in one sentence.

Respond in clear, professional clinical English.`;

export const PANEL_CONFIG: PanelConfig = {
  version: 1,
  features: { ambient: true, voice: true, plugins: true, ask: true },
  eva: { name: 'Eva', prompt: EVA_PROMPT },
  quickActions: [
    { id: 'ambient', label: 'Ambient mode', icon: 'Mic', tone: 'green' },
    { id: 'voice', label: 'Talk to Eva', icon: 'AudioLines', tone: 'indigo' },
    { id: 'book-follow-up', label: 'Book follow-up', icon: 'CalendarPlus', tone: 'blue' },
    { id: 'reports', label: 'Reports', icon: 'FileText', tone: 'indigo' },
    { id: 'review-visit', label: 'Review recent visit', icon: 'CalendarClock', tone: 'amber' },
    { id: 'visit-summary', label: 'Prepare visit summary', icon: 'FileCheck2', tone: 'rose' },
  ],
  launcherApps: [
    { id: 'ambient', label: 'Ambient Mode', icon: 'Mic', color: 'linear-gradient(135deg,#059669,#047857)' },
    { id: 'voice', label: 'Talk to Eva', icon: 'AudioLines', color: 'linear-gradient(135deg,#7c3aed,#4f46e5)' },
    { id: 'leads', label: 'Get Leads', icon: 'Users', color: 'linear-gradient(135deg,#4f46e5,#3b82f6)' },
    { id: 'scheduler', label: 'Scheduler', icon: 'CalendarDays', color: 'linear-gradient(135deg,#10b981,#059669)' },
    { id: 'campaigns', label: 'Campaign Manager', icon: 'Megaphone', color: 'linear-gradient(135deg,#6d28d9,#4f46e5)' },
    { id: 'report-analyzer', label: 'AI Report Analyzer', icon: 'FileSearch', color: 'linear-gradient(135deg,#c026d3,#7c3aed)' },
    { id: 'inventory', label: 'Inventory', icon: 'Package', color: 'linear-gradient(135deg,#4338ca,#6366f1)' },
    { id: 'crm', label: 'CRM', icon: 'Database', color: 'linear-gradient(135deg,#0284c7,#2563eb)' },
    { id: 'lab-booking', label: 'Lab Booking', icon: 'FlaskConical', color: 'linear-gradient(135deg,#047857,#065f46)' },
    { id: 'pharmacy', label: 'Pharmacy', icon: 'Pill', color: 'linear-gradient(135deg,#f43f5e,#db2777)' },
    { id: 'billing', label: 'Billing & Insurance', icon: 'ReceiptText', color: 'linear-gradient(135deg,#f97316,#ea580c)' },
  ],
  previewPlugins: [
    { id: 'demo.chat', label: 'Assistant', description: 'Chat about the patient in context (demo)', icon: 'MessageSquare', color: 'linear-gradient(135deg,#0ea5e9,#2563eb)', entry: 'chat' },
    { id: 'demo.slow', label: 'Long task', description: 'Shows progress, then a result (demo)', icon: 'Timer', color: 'linear-gradient(135deg,#14b8a6,#0f766e)', entry: 'action' },
    { id: 'demo.form', label: 'Order labs', description: 'Form-first plugin: no chat (demo)', icon: 'FlaskConical', color: 'linear-gradient(135deg,#047857,#065f46)', entry: 'view' },
    { id: 'demo.grid', label: 'Lab results', description: 'Results grid with selection (demo)', icon: 'ClipboardList', color: 'linear-gradient(135deg,#6366f1,#4338ca)', entry: 'view' },
    { id: 'demo.error', label: 'Failing plugin', description: 'Fails on purpose (demo)', icon: 'TriangleAlert', color: 'linear-gradient(135deg,#f59e0b,#d97706)', entry: 'action' },
  ],
};

/** The config as sent to the browser: everything except Eva's prompt. */
export function publicPanelConfig() {
  const { eva, ...rest } = PANEL_CONFIG;
  return { ...rest, eva: { name: eva.name } };
}

/** Eva's system prompt with the configured name filled in. */
export function evaPrompt(): string {
  return PANEL_CONFIG.eva.prompt.replaceAll('{{name}}', PANEL_CONFIG.eva.name);
}
