import * as React from 'react';

export interface SidebarItem {
  value: string;
  label: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Makes the item a link: a plain click still calls `onChange`, and ⌘-, Ctrl- or middle-click opens it in a new tab. */
  href?: string;
}

/** The console's 232px sidebar: paper, 1px right rule, 32px items, active item ink 500 on paper-sunken. */
export interface SidebarNavProps extends React.HTMLAttributes<HTMLElement> {
  items?: SidebarItem[];
  value?: string;
  onChange?: (value: string) => void;
  /** Usually the `Logo`. */
  header?: React.ReactNode;
  /** Account row, usage meter, theme toggle. */
  footer?: React.ReactNode;
}

export declare function SidebarNav(props: SidebarNavProps): JSX.Element;
