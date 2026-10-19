// Adding an adapter one step at a time.
//
// Every kind is set up in the same order: choose it, answer its own steps,
// name it, review. The first and the last two are this file's and read the
// same for every kind; the steps between are the kind's, from GET
// /adapters/kinds (KindInfo.Steps), so a kind added to Pando brings its own
// walk-through without this file learning about it (R-261).

import { useState } from 'react';
import { Banner, Button, Checkbox, Dialog, Icon, Input, Select } from '@design';

import { refusal } from './Accounts';
import { Disclosure } from '../ui/Disclosure';
import {
  advancedCount,
  advancedChanged,
  categoryLabel,
  formProblems,
  isShown,
  kindKey,
  kindSteps,
  matchKinds,
  reviewText,
  runs,
  stepFields,
  stepProblems,
} from './adapters';
import type { AdapterForm, AdapterKind, KindField, KindStep } from './adapters';

/** One screen of the walk-through. */
type Screen =
  | { kind: 'choose' }
  | { kind: 'step'; step: KindStep }
  | { kind: 'name' }
  | { kind: 'review' };

const screenID = (s: Screen) => (s.kind === 'step' ? `step:${s.step.id}` : s.kind);

const caption = { font: 'var(--type-caption)', color: 'var(--ink-secondary)', margin: 0 } as const;

export function AdapterGuide({
  categories,
  category,
  askCategory,
  onCategory,
  inCategory,
  chosen,
  onPick,
  skipChoose,
  kind,
  form,
  edit,
  stored,
  renderField,
  showDefault,
  isAI,
  saving,
  saveError,
  onSave,
  onShowAll,
  onClose,
}: {
  categories: string[];
  category: string;
  /** Whether the category is asked, or was given by where the dialog opened. */
  askCategory: boolean;
  onCategory: (c: string) => void;
  inCategory: AdapterKind[];
  chosen: string;
  onPick: (key: string) => void;
  /** A category with one kind, opened from that category, has nothing to choose. */
  skipChoose: boolean;
  kind?: AdapterKind;
  form: AdapterForm | null;
  edit: (patch: Partial<AdapterForm>) => void;
  stored: string[];
  renderField: (f: KindField, error?: string, instructed?: boolean) => React.ReactNode;
  showDefault: boolean;
  isAI: boolean;
  saving: boolean;
  saveError: unknown;
  onSave: () => void;
  onShowAll: () => void;
  onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const steps = kind && form ? kindSteps(kind, form.values) : [];
  const screens: Screen[] = [];
  if (!skipChoose) screens.push({ kind: 'choose' });
  for (const step of steps) screens.push({ kind: 'step', step });
  if (kind) screens.push({ kind: 'name' }, { kind: 'review' });
  const index = Math.min(at, screens.length - 1);
  // Never empty: there is a choice to make, or a kind and its last two screens.
  const screen: Screen = screens[index] ?? { kind: 'choose' };
  const last = index === screens.length - 1 && screen.kind === 'review';

  const go = (i: number) => {
    setErrors({});
    setAt(i);
  };
  const goTo = (id: string) => go(Math.max(0, screens.findIndex((s) => screenID(s) === id)));

  const next = () => {
    if (screen.kind === 'choose') {
      if (!kind) {
        setErrors({ choose: category ? 'Choose an adapter to continue.' : 'Choose a category to continue.' });
        return;
      }
    } else if (screen.kind === 'step' && kind && form) {
      const problems = stepProblems(kind, screen.step, form, stored);
      if (Object.keys(problems).length > 0) {
        setErrors(problems);
        return;
      }
    } else if (screen.kind === 'name' && kind && form) {
      const id = formProblems(kind, form, stored).id;
      if (id) {
        setErrors({ id });
        return;
      }
    } else if (screen.kind === 'review' && kind && form) {
      // Each step was checked on the way; one changed since is sent back to.
      const problems = formProblems(kind, form, stored);
      const back = screens.findIndex(
        (s) => s.kind === 'step' && stepFields(kind, s.step, form.values).some((f) => problems[f.key]),
      );
      const target = screens[back];
      if (target?.kind === 'step') {
        setAt(back);
        setErrors(stepProblems(kind, target.step, form, stored));
        return;
      }
      onSave();
      return;
    }
    go(index + 1);
  };

  const choosing = screen.kind === 'choose';
  const categoryWord = category === 'ai' ? 'AI' : categoryLabel(category).toLowerCase();
  // The kind is named once it is chosen and the walk-through has moved past
  // choosing it: on the first screen, a pick can still change.
  let title = 'Add adapter';
  if (kind && !choosing) title = `Add ${kind.name}`;
  else if (category) title = `Add ${categoryWord} adapter`;

  return (
    <Dialog
      open
      width={760}
      title={title}
      onClose={onClose}
      footer={
        <>
          {index > 0 && (
            <span style={{ marginRight: 'auto' }}>
              <Button variant="ghost" onClick={() => go(index - 1)}>
                Back
              </Button>
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={saving} onClick={next}>
            {last ? (saving ? 'Adding' : 'Add adapter') : 'Continue'}
          </Button>
        </>
      }
    >
      {/* Choosing the adapter has the dialog to itself: until one is chosen
          there are no steps to list. From its first step on, every step is
          named beside the one being answered. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: choosing ? 'minmax(0, 1fr)' : 'calc(var(--space-9) + var(--space-7)) minmax(0, 1fr)',
          gap: 'var(--space-6)',
          alignItems: 'start',
        }}
      >
        {!choosing && <StepRail screens={screens} index={index} onGo={go} onShowAll={onShowAll} />}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
          {screen.kind === 'choose' && (
            <>
              {askCategory && (
                <div>
                  <Select
                    label="Category"
                    value={category}
                    options={[
                      ...(category ? [] : [{ value: '', label: 'Choose a category' }]),
                      ...categories.map((c) => ({ value: c, label: categoryLabel(c) })),
                    ]}
                    onChange={(e) => {
                      setErrors({});
                      onCategory(e.target.value);
                    }}
                  />
                </div>
              )}
              {category && (
                <KindPicker
                  kinds={inCategory}
                  chosen={chosen}
                  onPick={(key) => {
                    setErrors({});
                    onPick(key);
                  }}
                />
              )}
              {errors.choose && <p style={{ ...caption, color: 'var(--marker-deep)' }}>{errors.choose}</p>}
            </>
          )}

          {screen.kind === 'step' && kind && form && (
            <StepBody step={screen.step}>
              {stepFields(kind, screen.step, form.values).map((f) => (
                <div key={f.key}>{renderField(f, errors[f.key], (screen.step.do?.length ?? 0) > 0)}</div>
              ))}
            </StepBody>
          )}

          {screen.kind === 'name' && kind && form && (
            <>
              <h4 style={{ font: 'var(--type-h4)', margin: 0 }}>Name</h4>
              <NameFields form={form} edit={edit} error={errors.id} />
              {showDefault && (
                <Checkbox
                  label={`Default ${categoryWord} adapter`}
                  checked={form.isDefault}
                  onChange={(e) => edit({ isDefault: e.target.checked })}
                />
              )}
              {isAI && <p style={caption}>Choose its functions after Pando restarts.</p>}
            </>
          )}

          {screen.kind === 'review' && kind && form && (
            <Review
              kind={kind}
              form={form}
              steps={steps}
              showDefault={showDefault}
              renderField={renderField}
              onChange={goTo}
            >
              {saveError ? <Banner tone="failed">{refusal(saveError)}</Banner> : null}
            </Review>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** A screen's name in the list of steps. */
function screenLabel(s: Screen): string {
  if (s.kind === 'choose') return 'Adapter';
  if (s.kind === 'step') return s.step.label;
  if (s.kind === 'name') return 'Name';
  return 'Review';
}

const quietLink = {
  ...caption,
  border: 0,
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left',
  textDecoration: 'underline',
  textDecorationColor: 'var(--rule-strong)',
  textUnderlineOffset: 'var(--space-1)',
} as const;

/**
 * Every step by name, so what is still to come is in view: finished ones
 * marked and a click from going back to, the current one set off.
 */
function StepRail({
  screens,
  index,
  onGo,
  onShowAll,
}: {
  screens: Screen[];
  index: number;
  onGo: (i: number) => void;
  onShowAll: () => void;
}) {
  const items: { label: string; state: 'done' | 'current' | 'next'; at: number }[] = screens.map((s, i) => ({
    label: screenLabel(s),
    state: i < index ? 'done' : i === index ? 'current' : 'next',
    at: i,
  }));

  return (
    <nav aria-label="Steps" style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        {items.map((it, i) => {
          const row = {
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            width: '100%',
            padding: 'var(--space-1) var(--space-2)',
            borderRadius: 'var(--radius-sm)',
            font: it.state === 'current' ? 'var(--type-label)' : 'var(--type-body-ui)',
            color: it.state === 'next' ? 'var(--ink-muted)' : 'var(--ink)',
            background: it.state === 'current' ? 'var(--paper-sunken)' : 'transparent',
            border: 0,
            textAlign: 'left',
          } as const;
          const marker = (
            <span
              aria-hidden="true"
              style={{
                flex: 'none',
                width: 'var(--space-4)',
                display: 'inline-flex',
                justifyContent: 'center',
                font: 'var(--type-code-sm)',
                color: 'var(--ink-secondary)',
              }}
            >
              {it.state === 'done' ? <Icon name="check" size={14} /> : it.at + 1}
            </span>
          );
          return (
            <li key={`${it.label}-${i}`} aria-current={it.state === 'current' ? 'step' : undefined}>
              {it.state === 'done' ? (
                <button type="button" onClick={() => onGo(it.at)} style={{ ...row, cursor: 'pointer' }}>
                  {marker}
                  {it.label}
                </button>
              ) : (
                <span style={row}>
                  {marker}
                  {it.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <button type="button" onClick={onShowAll} style={{ ...quietLink, paddingLeft: 'var(--space-2)' }}>
        Show all settings
      </button>
    </nav>
  );
}

/** More than this many kinds in a category, and the picker can be searched. */
const SEARCH_FROM = 6;

/**
 * The kinds of a category as tiles, two to a row, so a category with many
 * stays a short page; past a handful, a search narrows them. A radio group:
 * one is chosen, marked by a check as well as its border.
 */
function KindPicker({ kinds, chosen, onPick }: { kinds: AdapterKind[]; chosen: string; onPick: (key: string) => void }) {
  const [query, setQuery] = useState('');
  const shown = matchKinds(kinds, query);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {kinds.length > SEARCH_FROM && (
        <Input label="Search adapters" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <div
        role="radiogroup"
        aria-label="Adapter"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--space-3)' }}
      >
        {shown.map((k) => {
          const key = kindKey(k);
          const on = chosen === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              title={k.description}
              onClick={() => onPick(key)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                padding: 'var(--space-3) var(--space-4)',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'var(--paper-raised)',
                border: `var(--border-width) solid ${on ? 'var(--ink)' : 'var(--rule)'}`,
                borderRadius: 'var(--radius-md)',
                color: 'var(--ink)',
              }}
            >
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2)', font: 'var(--type-label)' }}>
                {k.name}
                {on && <Icon name="check" size={16} />}
              </span>
              <span
                style={{
                  ...caption,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {k.description}
              </span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 && <p style={caption}>No {kinds[0] ? categoryLabel(kinds[0].category).toLowerCase() : ''} adapter matches “{query.trim()}”.</p>}
    </div>
  );
}

/** Step text, with its two marks: bold for a name on the provider's screen,
 *  code for something typed exactly. */
export function Marked({ text }: { text: string }) {
  return (
    <>
      {runs(text).map((r, i) => {
        if (r.kind === 'bold') return <strong key={i} style={{ fontWeight: 600 }}>{r.text}</strong>;
        if (r.kind === 'code')
          return (
            <code
              key={i}
              style={{
                font: 'var(--type-code-sm)',
                background: 'var(--paper-sunken)',
                borderRadius: 'var(--radius-xs)',
                padding: '0 var(--space-1)',
                overflowWrap: 'anywhere',
              }}
            >
              {r.text}
            </code>
          );
        return <span key={i}>{r.text}</span>;
      })}
    </>
  );
}

/** A kind's step: its title, why it is asked, what to do, and its settings. */
function StepBody({ step, children }: { step: KindStep; children: React.ReactNode }) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <h4 style={{ font: 'var(--type-h4)', margin: 0 }}>{step.title}</h4>
        {step.lede && (
          <p style={{ font: 'var(--type-body-ui)', color: 'var(--ink-secondary)', margin: 0 }}>
            <Marked text={step.lede} />
          </p>
        )}
      </div>
      {step.do && step.do.length > 0 && (
        <ol
          style={{
            margin: 0,
            paddingLeft: 'var(--space-5)',
            font: 'var(--type-body-ui)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {step.do.map((a, i) => (
            <li key={i}>
              <Marked text={a.text} />
              {a.table && <StepTable table={a.table} />}
            </li>
          ))}
        </ol>
      )}
      {step.link && (
        <a
          href={step.link.url}
          target="_blank"
          rel="noreferrer"
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            height: 'var(--control-console)',
            padding: '0 var(--button-padding-console)',
            font: 'var(--type-label)',
            color: 'var(--ink)',
            textDecoration: 'none',
            background: 'var(--paper-raised)',
            border: 'var(--border-width) solid var(--rule-strong)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <Icon name="external-link" size={16} />
          {step.link.label}
        </a>
      )}
      {children}
    </>
  );
}

function StepTable({ table }: { table: NonNullable<NonNullable<KindStep['do']>[number]['table']> }) {
  return (
    <table
      style={{
        marginTop: 'var(--space-2)',
        width: '100%',
        background: 'var(--paper-sunken)',
        borderRadius: 'var(--radius-md)',
        font: 'var(--type-code-sm)',
        textAlign: 'left',
      }}
    >
      <thead>
        <tr>
          {table.columns.map((c) => (
            <th key={c} style={{ ...caption, fontWeight: 400, padding: 'var(--space-2) var(--space-3) var(--space-1)' }}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j} style={{ padding: 'var(--space-1) var(--space-3)' }}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NameFields({ form, edit, error }: { form: AdapterForm; edit: (p: Partial<AdapterForm>) => void; error?: string }) {
  return (
    <>
      <Input label="Name" value={form.name} onChange={(e) => edit({ name: e.target.value })} />
      <Input
        label="ID"
        mono
        value={form.id}
        helper="Can’t be changed later."
        error={error}
        onChange={(e) => edit({ id: e.target.value })}
      />
    </>
  );
}

/** Every answer, by the step that asked it, each a click from changing. */
function Review({
  kind,
  form,
  steps,
  showDefault,
  renderField,
  onChange,
  children,
}: {
  kind: AdapterKind;
  form: AdapterForm;
  steps: KindStep[];
  showDefault: boolean;
  renderField: (f: KindField, error?: string, instructed?: boolean) => React.ReactNode;
  onChange: (screenID: string) => void;
  children: React.ReactNode;
}) {
  const rows: { label: string; value: string; mono: boolean; to: string }[] = [];
  for (const st of steps) {
    for (const f of stepFields(kind, st, form.values)) {
      const value = reviewText(f, form.values[f.key]);
      const typed = typeof form.values[f.key] === 'string' && String(form.values[f.key]).trim() !== '';
      rows.push({ label: f.label, value, mono: typed && !f.credential && f.type === 'string', to: `step:${st.id}` });
    }
  }
  rows.push({ label: 'Name', value: form.name.trim() || kind.name, mono: false, to: 'name' });
  rows.push({ label: 'ID', value: form.id.trim(), mono: true, to: 'name' });
  if (showDefault) rows.push({ label: 'Default', value: form.isDefault ? 'Yes' : 'No', mono: false, to: 'name' });

  const advanced = (kind.fields ?? []).filter((f) => f.advanced);
  const { total } = advancedCount(kind, form.values);

  return (
    <>
      <h4 style={{ font: 'var(--type-h4)', margin: 0 }}>Review</h4>
      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr max-content',
          gap: 'var(--space-2) var(--space-4)',
          font: 'var(--type-body-ui)',
        }}
      >
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--ink-secondary)' }}>{r.label}</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere', font: r.mono ? 'var(--type-code)' : undefined }}>{r.value}</dd>
            <button
              type="button"
              onClick={() => onChange(r.to)}
              aria-label={`Change ${r.label}`}
              style={{
                ...caption,
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                textDecoration: 'underline',
                textDecorationColor: 'var(--rule-strong)',
                textUnderlineOffset: 'var(--space-1)',
              }}
            >
              Change
            </button>
          </div>
        ))}
      </dl>
      <Disclosure
        show="Advanced settings"
        hide="Advanced settings"
        hidden={total === 0}
        initiallyOpen={advancedChanged(kind, form.values)}
      >
        {advanced.filter((f) => isShown(kind, f, form.values)).map((f) => (
          <div key={f.key}>{renderField(f)}</div>
        ))}
      </Disclosure>
      {children}
    </>
  );
}
