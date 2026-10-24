// What Groups and roles, a group's page and a role's page share: the shapes
// the API answers with, a page's header and Details card, a card's line, and
// the dialogs for renaming one and choosing one.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banner, Button, Card, Dialog, Icon, IconButton, Input, Select } from '@design';

import { api } from '@api/client';
import { CopyInline } from '../ui/CopyField';
import { SHOWN, SearchPicker, type Picked } from '../ui/SearchPicker';
import { withParams } from '../ui/paged';
import { refusal, sentence } from './Accounts';

import './identity.css';

export interface Group {
  id: string;
  name: string;
  /** The identity provider that owns the membership, and its name. */
  source?: string;
  source_name?: string;
  /** How many people are in the group directly. */
  member_count?: number;
  /** On a Pando group: the provider groups whose members count as its own. */
  linked_from?: string[] | null;
  /** The installation role everyone in the group holds; '' for none. */
  install_role_id?: string;
  created_at?: string;
}

export interface Role {
  id: string;
  name: string;
  scope?: string;
  builtin: boolean;
  verbs: string[];
}

export interface Member {
  id: string;
  display_name?: string;
  email?: string;
  external_id: string;
}

/** A role's name as shown: the built-ins are stored lowercase. */
export const roleName = (r: Role) => (r.builtin ? sentence(r.name) : r.name);

export const permissionCount = (n: number) => (n === 1 ? '1 permission' : `${n} permissions`);

export const scopeLabel = (r: Role) => (r.scope === 'install' ? 'Installation' : 'App');

/** Every role, of both scopes. */
export function useAllRoles() {
  return useQuery({
    queryKey: ['roles', 'all'],
    queryFn: () => api.get<{ roles: Role[] | null }>('/roles?scope=all'),
  });
}

/**
 * Where a group comes from: its provider, Pando, or Pando with the provider
 * groups linked to it, named by their provider when the list has them —
 * "Pando · 2 Okta groups".
 */
export function sourceLabel(group: Group, known: Group[]): string {
  if (group.source) return group.source_name || group.source;
  const linked = group.linked_from ?? [];
  if (linked.length === 0) return 'Pando';
  return `Pando · ${linked.length} ${providerOf(linked, known)} ${linked.length === 1 ? 'group' : 'groups'}`;
}

/** The provider of these synced groups, when the list has them and they share one. */
export function providerOf(ids: string[], known: Group[]): string {
  const names = new Set(ids.map((id) => known.find((g) => g.id === id)?.source_name).filter(Boolean));
  const [only] = names;
  return names.size === 1 && only ? only : 'provider';
}

/** The square a group or a role is shown in. */
export function Mark({ icon, large = false }: Readonly<{ icon: 'users' | 'key-round'; large?: boolean }>) {
  return (
    <span className="pando-id-mark" data-large={large || undefined} aria-hidden="true">
      <Icon name={icon} size={large ? 24 : 16} />
    </span>
  );
}

/** The circle an account is shown in: its initials. */
export function Initials({ name }: Readonly<{ name: string }>) {
  const letters = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return (
    <span className="pando-id-mark" data-round aria-hidden="true">
      {letters}
    </span>
  );
}

/** A page's header: back to the list, its mark and name, and what can be done to it. */
export function PageHeader({
  back,
  icon,
  name,
  onRename,
  onDelete,
}: Readonly<{
  back: () => void;
  icon: 'users' | 'key-round';
  name: string;
  onRename?: () => void;
  onDelete?: () => void;
}>) {
  return (
    <header style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <Button variant="ghost" icon={<Icon name="arrow-left" />} onClick={back} style={{ alignSelf: 'flex-start' }}>
        Groups and roles
      </Button>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', minWidth: 0 }}>
          <Mark icon={icon} large />
          <h3 style={{ font: 'var(--type-h3)', margin: 0, overflowWrap: 'anywhere' }}>{name}</h3>
          {onRename && (
            <Button variant="ghost" icon={<Icon name="pencil" />} onClick={onRename}>
              Rename
            </Button>
          )}
        </div>
        {onDelete && (
          <Button variant="destructive" onClick={onDelete}>
            Delete
          </Button>
        )}
      </div>
    </header>
  );
}

/** A card with its title, and what sits beside the title. */
export function IdCard({
  title,
  action,
  children,
}: Readonly<{ title: string; action?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <Card as="section" aria-label={title} tone="paper" padding="md" style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-3)',
          paddingBottom: 'var(--space-3)',
        }}
      >
        <h4 style={{ font: 'var(--type-h4)', margin: 0 }}>{title}</h4>
        {action && <div style={{ display: 'flex', gap: 'var(--space-1)' }}>{action}</div>}
      </div>
      {children}
    </Card>
  );
}

/** The Details card: label over value. */
export function Details({ facts, id }: Readonly<{ facts: Array<[string, React.ReactNode]>; id: string }>) {
  return (
    <IdCard title="Details">
      <dl className="pando-id-facts">
        {facts.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div>
          <dt>ID</dt>
          <dd style={{ font: 'var(--type-code-sm)' }}>
            <CopyInline value={id} />
          </dd>
        </div>
      </dl>
    </IdCard>
  );
}

/** One line in a card. */
export function Row({ children, end }: Readonly<{ children: React.ReactNode; end?: React.ReactNode }>) {
  return (
    <div className="pando-id-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>{children}</div>
      {end && <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flex: '0 0 auto' }}>{end}</div>}
    </div>
  );
}

/** Remove, as an icon at the end of a row. */
export function Remove({ what, disabled, onRemove }: Readonly<{ what: string; disabled?: boolean; onRemove: () => void }>) {
  return (
    <IconButton label={`Remove ${what}`} disabled={disabled} onClick={onRemove}>
      <Icon name="x" />
    </IconButton>
  );
}

/** An add button in a card's title row. */
export function AddButton({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <Button variant="ghost" icon={<Icon name="plus" />} onClick={onClick}>
      {label}
    </Button>
  );
}

/** The dialog's footer: Cancel, and the action it is for. */
function Footer({
  onClose,
  label,
  busy,
  disabled,
  onConfirm,
}: Readonly<{ onClose: () => void; label: string; busy: boolean; disabled: boolean; onConfirm: () => void }>) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button variant="primary" disabled={busy || disabled} onClick={onConfirm}>
        {label}
      </Button>
    </>
  );
}

/** Renames a group or a role: PATCH `path` with its new name. */
export function RenameDialog({
  title,
  current,
  path,
  onClose,
}: Readonly<{ title: string; current: string; path: string; onClose: () => void }>) {
  const queries = useQueryClient();
  const [name, setName] = useState(current);
  const save = useMutation({
    mutationFn: () => api.patch<unknown>(path, { name: name.trim() }),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: ['groups'] });
      void queries.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label={save.isPending ? 'Saving' : 'Rename'}
          busy={save.isPending}
          disabled={!name.trim() || name.trim() === current}
          onConfirm={() => save.mutate()}
        />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        {save.isError && <Banner tone="failed">{refusal(save.error)}</Banner>}
      </div>
    </Dialog>
  );
}

/** Accounts matching q, for a picker. */
export async function findAccounts(q: string): Promise<Picked[]> {
  const page = await api.get<{ users: Member[] | null }>(withParams('/users', { q, limit: SHOWN }));
  return (page.users ?? []).map((u) => ({ id: u.id, label: u.display_name || u.external_id }));
}

/** Groups matching q, for a picker. */
export async function findGroups(q: string): Promise<Picked[]> {
  const page = await api.get<{ groups: Group[] | null }>(withParams('/groups', { q, limit: SHOWN }));
  return (page.groups ?? []).map((g) => ({ id: g.id, label: g.name }));
}

/** Chooses one account or group, then does `act` with it. */
export function PickDialog({
  title,
  noun,
  label,
  find,
  act,
  onDone,
  onClose,
}: Readonly<{
  title: string;
  /** What is listed, plural: "accounts". */
  noun: string;
  label: string;
  find: (q: string) => Promise<Picked[]>;
  act: (id: string) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}>) {
  const [chosen, setChosen] = useState<Picked | null>(null);
  const run = useMutation({
    mutationFn: () => act(chosen!.id),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label={run.isPending ? 'Adding' : 'Add'}
          busy={run.isPending}
          disabled={!chosen}
          onConfirm={() => run.mutate()}
        />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <SearchPicker label={label} noun={noun} search={{ key: (q) => [noun, 'pick', q], find }} onChange={setChosen} />
        {run.isError && <Banner tone="failed">{refusal(run.error)}</Banner>}
      </div>
    </Dialog>
  );
}

/** Chooses one value from a short list: a group's installation role. */
export function ChooseDialog({
  title,
  label,
  value,
  options,
  save,
  onClose,
}: Readonly<{
  title: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  save: (value: string) => Promise<unknown>;
  onClose: () => void;
}>) {
  const [picked, setPicked] = useState(value);
  const run = useMutation({ mutationFn: () => save(picked), onSuccess: onClose });
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <Footer
          onClose={onClose}
          label={run.isPending ? 'Saving' : 'Save'}
          busy={run.isPending}
          disabled={picked === value}
          onConfirm={() => run.mutate()}
        />
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Select label={label} value={picked} options={options} onChange={(e) => setPicked(e.target.value)} />
        {run.isError && <Banner tone="failed">{refusal(run.error)}</Banner>}
      </div>
    </Dialog>
  );
}
