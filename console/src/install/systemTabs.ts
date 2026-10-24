// The tab bar System used to hand the screen under it.
//
// System's pages are now a list beside one page at a time (System.tsx), each
// with its own heading, and nothing provides this any more: Screen reads it
// and, finding none, draws its own heading as it does everywhere else. Kept
// until Screen stops reading it.

import { createContext } from 'react';

import type { TabItem } from '@design';

export interface SystemTabBar {
  value: string;
  items: TabItem[];
  onChange: (value: string) => void;
}

export const SystemTabs = createContext<SystemTabBar | null>(null);
