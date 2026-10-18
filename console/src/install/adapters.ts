// Adding and changing an adapter from the console — the form's logic, kept out
// of the component so it can be tested without rendering one.
//
// The form is built from GET /adapters/kinds, which each adapter package fills
// in about itself (R-254: capabilities, and settings, are data). Nothing here
// knows what an Anthropic or a Traefik adapter takes; a kind added to Pando is
// configurable here without this file changing (R-261).

/** One choice a `select` setting offers. */
interface KindOption {
  value: string;
  label: string;
  /** What choosing it means, shown under a radio button. */
  description?: string;
}

/** One setting a kind of adapter takes. */
export interface KindField {
  key: string;
  label: string;
  help?: string;
  type: 'string' | 'int' | 'bool' | 'select';
  required?: boolean;
  /** A secret such as an API key: sent in `credentials`, never in `config`
   *  (R-190), and never shown again. */
  credential?: boolean;
  /** What the adapter uses when the setting is left empty. Shown in the
   *  empty field, so what it says is what happens. */
  default?: string;
  /** An example, for a setting with no default. */
  placeholder?: string;
  /** What a `select` offers. */
  options?: KindOption[];
  /** A `select` that also takes a value it does not list, typed in. */
  other?: boolean;
  /** Asks for a text area, such as credentials given as NAME=value lines. */
  multiline?: boolean;
  /** Shown only while another setting has one of these values. */
  shown_when?: { key: string; values: string[] };
  /** A setting most people never change, asked for under "Advanced
   *  settings". Never required, and always with a default. */
  advanced?: boolean;
}

/** Whether any advanced setting is set to something other than its default,
 *  so a form opens them rather than hiding what is configured. */
export function advancedChanged(kind: AdapterKind, values: Record<string, string | boolean>): boolean {
  return (kind.fields ?? []).some((f) => {
    if (!f.advanced || !(f.key in values)) return false;
    if (f.type === 'bool') return boolValue(f, values[f.key]) !== (f.default === 'true');
    const text = String(values[f.key]).trim();
    return text !== '' && text !== f.default;
  });
}

/** A bool setting as it stands: what was set, or the kind's default. */
export function boolValue(f: KindField, v: string | boolean | undefined): boolean {
  return typeof v === 'boolean' ? v : f.default === 'true';
}

/** A setting as the adapter will read it, as text: what was entered, or the
 *  kind's default. A bool is "true" or "false". */
export function effectiveText(f: KindField, v: string | boolean | undefined): string {
  if (f.type === 'bool') return String(boolValue(f, v));
  const text = typeof v === 'string' ? v.trim() : '';
  return text || f.default || '';
}

/** Whether a setting applies, given the others. A hidden one is neither
 *  checked nor sent: a DNS provider means nothing without DNS certificates. */
export function isShown(kind: AdapterKind, f: KindField, values: Record<string, string | boolean>): boolean {
  if (!f.shown_when) return true;
  const on = (kind.fields ?? []).find((x) => x.key === f.shown_when!.key);
  if (!on) return true;
  return f.shown_when.values.includes(effectiveText(on, values[on.key]));
}

/** The text an empty field shows: the default when there is one, since
 *  that is what leaving it empty gets, and an example otherwise. */
export function fieldPlaceholder(f: KindField): string | undefined {
  return f.default || f.placeholder;
}

/** A kind of adapter this build of Pando can run. */
export interface AdapterKind {
  category: string;
  kind: string;
  name: string;
  description: string;
  id_prefix: string;
  fields: KindField[] | null;
  /** Guided setup: one screen per step, each asking for some of `fields`. */
  steps?: KindStep[] | null;
}

/** One step of a kind's guided setup, as GET /adapters/kinds describes it. */
export interface KindStep {
  id: string;
  /** Its name in the list of steps, a word or two. */
  label: string;
  /** An instruction or a question. */
  title: string;
  lede?: string;
  /** What to do outside Pando, in order. */
  do?: { text: string; table?: { columns: string[]; rows: string[][] } }[];
  link?: { label: string; url: string };
  /** The keys of the settings asked on this step. */
  fields: string[];
  shown_when?: { key: string; values: string[] };
}

/** A run of step text: plain, **bold** (a name on the provider's screen) or
 *  `code` (something typed exactly). */
export interface Run {
  kind: 'text' | 'bold' | 'code';
  text: string;
}

/** Step text split into runs. Only the two marks are read; anything else,
 *  including an unclosed mark, is plain text. Never HTML. */
export function runs(text: string): Run[] {
  const out: Run[] = [];
  const mark = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const m of text.matchAll(mark)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push(m[1] === undefined ? { kind: 'code', text: m[2] ?? '' } : { kind: 'bold', text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * The kind's steps that apply, given what has been answered so far: a step
 * shown only for another setting's value is skipped otherwise. A kind that
 * declares no steps gets one, asking for all its basic settings, so every kind
 * can be set up the guided way.
 */
export function kindSteps(kind: AdapterKind, values: Record<string, string | boolean>): KindStep[] {
  const declared = kind.steps ?? [];
  if (declared.length === 0) {
    const basic = (kind.fields ?? []).filter((f) => !f.advanced).map((f) => f.key);
    return basic.length === 0 ? [] : [{ id: 'settings', label: 'Settings', title: `Enter the ${kind.name} settings`, fields: basic }];
  }
  return declared.filter((st) => {
    if (!st.shown_when) return true;
    const on = (kind.fields ?? []).find((f) => f.key === st.shown_when!.key);
    return !on || st.shown_when.values.includes(effectiveText(on, values[on.key]));
  });
}

/** The settings a step shows, in its order: those it names that apply. */
export function stepFields(kind: AdapterKind, step: KindStep, values: Record<string, string | boolean>): KindField[] {
  const byKey = new Map((kind.fields ?? []).map((f) => [f.key, f]));
  return step.fields
    .map((k) => byKey.get(k))
    .filter((f): f is KindField => f !== undefined && isShown(kind, f, values));
}

/** The kinds a search matches, by name or description. */
export function matchKinds(kinds: AdapterKind[], query: string): AdapterKind[] {
  const q = query.trim().toLowerCase();
  if (!q) return kinds;
  return kinds.filter((k) => k.name.toLowerCase().includes(q) || k.description.toLowerCase().includes(q));
}

/** The problems with a step's own settings — what Continue checks. */
export function stepProblems(
  kind: AdapterKind,
  step: KindStep,
  form: AdapterForm,
  credentialsSet: string[] = [],
): Record<string, string> {
  const all = formProblems(kind, form, credentialsSet);
  const out: Record<string, string> = {};
  for (const f of stepFields(kind, step, form.values)) {
    const problem = all[f.key];
    if (problem) out[f.key] = problem;
  }
  return out;
}

/** A setting as the review states it: what the adapter will use. */
export function reviewText(f: KindField, v: string | boolean | undefined): string {
  if (f.type === 'bool') return boolValue(f, v) ? 'Yes' : 'No';
  const text = typeof v === 'string' ? v.trim() : '';
  if (f.credential) return text ? 'Entered' : 'Not entered';
  const used = text || f.default || '';
  if (!used) return 'None';
  if (f.type === 'select') return f.options?.find((o) => o.value === used)?.label ?? used;
  return used;
}

/** How many advanced settings are changed from their defaults. */
export function advancedCount(kind: AdapterKind, values: Record<string, string | boolean>): { total: number; changed: number } {
  const adv = (kind.fields ?? []).filter((f) => f.advanced && isShown(kind, f, values));
  const changed = adv.filter((f) => advancedChanged({ ...kind, fields: [f] }, values)).length;
  return { total: adv.length, changed };
}

/** What the form holds: text for every field, whatever its type, and a
 *  boolean for a bool — so a half-typed number is kept as typed. */
export interface AdapterForm {
  id: string;
  name: string;
  isDefault: boolean;
  values: Record<string, string | boolean>;
}

export interface AdapterRequest {
  id: string;
  category: string;
  kind: string;
  name: string;
  config: Record<string, string | number | boolean>;
  credentials?: Record<string, string>;
  is_default: boolean;
  enabled?: boolean;
}

/** What making an adapter its category's default in place of another changes
 *  (issue #220), worded as the API's `handover`. An app's spec names the
 *  routing, runtime and builder adapters it was added with, so a new default
 *  of those reaches only apps added after it. */
export function defaultHandover(name: string, previous: string, category: string): string {
  const word = category === 'ai' ? 'AI' : category.replaceAll('_', ' ');
  let s = `This makes ${name} the default ${word} adapter in place of ${previous}.`;
  if (category === 'routing' || category === 'runtime' || category === 'builder') {
    s += ` Apps already added keep the ${word} adapter they were added with; apps added from now on use ${name}.`;
  }
  return s;
}

/** The key a kind is chosen by in the form's select. */
export function kindKey(k: { category: string; kind: string }): string {
  return `${k.category}/${k.kind}`;
}

/** Category names as a person reads them. `ai` is an initialism; the rest are
 *  words, in sentence case like everything else. */
export function categoryLabel(category: string): string {
  if (category === 'ai') return 'AI';
  if (category === 'image_registry') return 'Image registry';
  if (category === 'audit_sink') return 'Audit sink';
  return category.charAt(0).toUpperCase() + category.slice(1);
}

// The categories in the order an installation is built up: where apps run and
// how they are reached first, then what they are built with and what they
// lean on, then the extras. One not listed here sorts after these, by name.
const CATEGORY_ORDER = ['runtime', 'routing', 'builder', 'image_registry', 'services', 'secrets', 'backup', 'scanner', 'ai', 'notify', 'audit_sink', 'identity'];

const CATEGORY_NOTES: Record<string, string> = {
  runtime: 'Where apps run. Starts, stops and watches their containers.',
  routing: 'How apps are reached: their addresses, and the edge that sends requests through Pando.',
  builder: 'Turns an app\u2019s source into an image.',
  image_registry: 'Where Pando pushes built images for a runtime to pull. A single Docker host needs none.',
  services: 'Databases and caches apps declare, such as PostgreSQL or Redis.',
  secrets: 'Where secret values are kept, encrypted.',
  backup: 'Where backups of Pando and app storage are written.',
  scanner: 'Checks apps for known vulnerabilities, for the security score.',
  ai: 'An AI provider, such as Anthropic. Handles the AI functions chosen on it.',
  notify: 'Where notifications go, such as the console itself.',
  audit_sink: 'Sends each audit event to a syslog collector or a SIEM\u2019s HTTPS endpoint. Needs install.audit.export.',
  identity: 'Where accounts come from and how people sign in.',
  source: 'How Pando reads private repositories on GitHub, GitLab, Azure DevOps, Bitbucket, Gitea or any git host.',
};

/** One line on what a category of adapter is for. */
export function categoryNote(category: string): string {
  return CATEGORY_NOTES[category] ?? '';
}

/** Categories in the order the screen shows them. */
export function orderCategories(categories: Iterable<string>): string[] {
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i >= 0 ? i : CATEGORY_ORDER.length;
  };
  return [...new Set(categories)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The kinds in the order the select offers them: by category, then by name. */
export function sortKinds(kinds: AdapterKind[]): AdapterKind[] {
  return [...kinds].sort(
    (a, b) => categoryLabel(a.category).localeCompare(categoryLabel(b.category)) || a.name.localeCompare(b.name),
  );
}

/** A new adapter's form, prefilled from its kind. */
export function blankForm(kind: AdapterKind, firstOfCategory: boolean): AdapterForm {
  return {
    id: `${kind.id_prefix}${kind.kind}`,
    name: kind.name,
    // The first adapter of a category is the one anything that needs that
    // category will use, so it is the default unless someone says otherwise.
    isDefault: firstOfCategory,
    values: {},
  };
}

/**
 * What is wrong with the form, by field key, in words that say how to fix it.
 * Empty when it can be sent.
 *
 * `credentialsSet` names the credentials already stored for the adapter being
 * changed: a required one of those may be left empty, which keeps it.
 */
export function formProblems(
  kind: AdapterKind,
  form: AdapterForm,
  credentialsSet: string[] = [],
): Record<string, string> {
  const problems: Record<string, string> = {};
  if (!form.id.trim()) problems.id = `An adapter needs an ID, for example ${kind.id_prefix}${kind.kind}.`;
  for (const f of kind.fields ?? []) {
    const v = form.values[f.key];
    if (f.type === 'bool' || !isShown(kind, f, form.values)) continue;
    const text = typeof v === 'string' ? v.trim() : '';
    if (text === '') {
      // A required setting with a default is answered by it: a select
      // shows its default chosen, and the adapter uses it.
      const kept = (f.credential && credentialsSet.includes(f.key)) || Boolean(f.default);
      if (f.required && !kept) problems[f.key] = `${f.label} is required.`;
      continue;
    }
    if (f.type === 'int' && !/^-?\d+$/.test(text)) {
      problems[f.key] = `${f.label} takes a whole number, such as ${[f.default, f.placeholder].find((x) => x && /^\d+$/.test(x)) ?? '30'}.`;
    }
  }
  return problems;
}

/**
 * The body of POST /adapters for a form.
 *
 * Credentials go in `credentials` and nowhere else — the server refuses them in
 * `config`, which is stored in the clear (R-190). An empty field is left out:
 * an empty credential keeps the stored one (a "" would remove it), and an empty
 * setting is the adapter's own default. Ints go as JSON numbers, because the
 * adapter reads its config as typed JSON. A bool is sent only when it differs
 * from its default, since the default is what an absent one means — which for
 * most is off, and for some, such as Pando running Traefik, is on. A setting
 * hidden by another's value is not sent.
 *
 * Call formProblems first; a field it would refuse is not sent correctly here.
 */
export function adapterRequest(kind: AdapterKind, form: AdapterForm, enabled?: boolean): AdapterRequest {
  const config: AdapterRequest['config'] = {};
  const credentials: Record<string, string> = {};
  for (const f of kind.fields ?? []) {
    const v = form.values[f.key];
    if (!isShown(kind, f, form.values)) continue;
    if (f.type === 'bool') {
      const on = boolValue(f, v);
      if (on !== (f.default === 'true')) config[f.key] = on;
      continue;
    }
    const text = typeof v === 'string' ? v.trim() : '';
    if (text === '') continue;
    if (f.credential) credentials[f.key] = text;
    else if (f.type === 'int') config[f.key] = Number.parseInt(text, 10);
    else config[f.key] = text;
  }

  const body: AdapterRequest = {
    id: form.id.trim(),
    category: kind.category,
    kind: kind.kind,
    name: form.name.trim() || kind.name,
    config,
    is_default: form.isDefault,
  };
  if (Object.keys(credentials).length > 0) body.credentials = credentials;
  // Sent when changing an existing adapter, so saving one that was turned off
  // does not quietly turn it back on: the server's default is enabled.
  if (enabled !== undefined) body.enabled = enabled;
  return body;
}
