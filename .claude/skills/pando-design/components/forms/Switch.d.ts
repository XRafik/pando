import * as React from 'react';

/**
 * Toggle for a setting that takes effect the moment it flips. The track is the
 * one place besides status dots where the system uses a pill shape.
 */
export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  checked?: boolean;
  label?: string;
  description?: string;
  /** `status` draws on in the running status color, for a switch whose state
   *  is what the screen is read for. Pair it with a label saying On or Off. */
  tone?: 'default' | 'status';
}

export declare function Switch(props: SwitchProps): JSX.Element;
