// The side panel over an app's screen: Output, Deployments and Terminal.
//
// Each was a tab. They are not things somebody reads the app's screen for —
// they are what somebody opens from it, about one workload or one deploy, and
// closes again — so they slide over the screen at three quarters of the window
// and keep it in view beside them. The panel has its own address
// (`?panel=output&workload=worker`), so a reload or a link lands on it.
//
// Anything on the app's screen opens it through `useOpenPanel`.

import { createContext, useContext } from 'react';
import { Tabs } from '@design';
import type { TabItem } from '@design';

import type { App } from '@api/types.gen';
import type { PanelView } from '../app/route';
import { SidePanel } from '../ui/SidePanel';
import { PanelDeployments } from './PanelDeployments';
import { PanelOutput } from './PanelOutput';
import { Terminal } from './Terminal';
import { AppVerb, AppVerbs, can } from './verbs';

export type { PanelView };

/** What the panel shows: a view, and the workload or deployment in it. */
export interface PanelTarget {
  view: PanelView;
  /** Output and Terminal: which workload. The app's primary when absent. */
  workload?: string;
  /** Deployments: which one, or NOT_DEPLOYED. The newest when absent. */
  deployment?: string;
}

const LABELS: Record<PanelView, string> = {
  output: 'Output',
  deployments: 'Deployments',
  terminal: 'Terminal',
};

/**
 * The views this person may open, by the verbs their endpoints check: output
 * and deploy logs are `app.logs.read`, a terminal is `app.exec` (R-084).
 */
export function panelViews(verbs: readonly string[] | null | undefined): PanelView[] {
  const views: PanelView[] = [];
  if (can(verbs, AppVerb.LogsRead)) views.push('output', 'deployments');
  if (can(verbs, AppVerb.Exec)) views.push('terminal');
  return views;
}

/** Opens the panel, from anywhere on an app's screen. Absent outside one. */
const OpenPanel = createContext<((target: PanelTarget) => void) | undefined>(undefined);

export const PanelOpener = OpenPanel.Provider;

/**
 * How a control on the app's screen opens the panel. Undefined where there is
 * no panel to open, and for a view this person may not use — so a control
 * that would open it is left out rather than offered and refused.
 */
export function useOpenPanel(view?: PanelView): ((target: PanelTarget) => void) | undefined {
  const open = useContext(OpenPanel);
  const views = panelViews(useContext(AppVerbs));
  if (!open) return undefined;
  if (view && !views.includes(view)) return undefined;
  return open;
}

export function AppPanel({
  app,
  verbs,
  target,
  onChange,
  onClose,
  hrefOf,
}: Readonly<{
  app: App;
  verbs: readonly string[] | null | undefined;
  target: PanelTarget;
  /** The panel shows something else: written to the address. */
  onChange: (target: PanelTarget) => void;
  onClose: () => void;
  /** The address of a view, so each tab is a link. */
  hrefOf?: (target: PanelTarget) => string;
}>) {
  const views = panelViews(verbs);
  // A link to a view this person cannot use lands on the first they can.
  const view = views.includes(target.view) ? target.view : views[0];
  if (!view) return null;

  const items: TabItem[] = views.map((v) => ({
    value: v,
    label: LABELS[v],
    href: hrefOf?.({ view: v, workload: target.workload }),
  }));

  return (
    <SidePanel title={app.name} expandable onClose={onClose}>
      <Tabs
        value={view}
        items={items}
        // Output and Terminal are about the same workload; a deployment
        // belongs to Deployments alone.
        onChange={(v) => onChange({ view: v as PanelView, workload: target.workload })}
        style={{ padding: '0 var(--space-5)' }}
      />

      <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {view === 'output' && (
          <PanelOutput app={app} workload={target.workload} onWorkload={(workload) => onChange({ view, workload })} />
        )}
        {view === 'deployments' && (
          <PanelDeployments app={app} deployment={target.deployment} onDeployment={(deployment) => onChange({ view, deployment })} />
        )}
        {view === 'terminal' && (
          <Terminal appID={app.id} workload={target.workload} onWorkload={(workload) => onChange({ view, workload })} />
        )}
      </div>
    </SidePanel>
  );
}
