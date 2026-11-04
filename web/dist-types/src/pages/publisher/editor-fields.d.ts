import { type ReactNode } from 'react';
import { type Draft } from '../../editor/draft';
export type Edit = (next: Draft) => void;
/** A text input with its count against [max]. */
export declare function TextField({ label, value, onChange, max, rows, placeholder, hint }: {
    label: ReactNode;
    value: string;
    onChange: (v: string) => void;
    max?: number;
    rows?: number;
    placeholder?: string;
    hint?: ReactNode;
}): import("react").JSX.Element;
/** A number input; empty is undefined. */
export declare function NumberField({ label, value, onChange, step, min, max }: {
    label: ReactNode;
    value: unknown;
    onChange: (v: number | undefined) => void;
    step?: number | 'any';
    min?: number;
    max?: number;
}): import("react").JSX.Element;
/** Checkboxes over [options]; the value is the chosen ones in the options' order. */
export declare function Choices({ label, options, value, onChange, labels }: {
    label: ReactNode;
    options: readonly string[];
    value: string[];
    onChange: (v: string[]) => void;
    labels?: Record<string, string>;
}): import("react").JSX.Element;
export declare function Select({ label, value, options, onChange, labels, blank }: {
    label: ReactNode;
    value: string;
    options: readonly string[];
    onChange: (v: string) => void;
    labels?: Record<string, string>;
    blank?: string;
}): import("react").JSX.Element;
export declare const SLOT_LABEL: Record<string, string>;
export declare function ChannelBasics({ d, edit, accountId, latest }: {
    d: Draft;
    edit: Edit;
    accountId?: string | undefined;
    latest?: number | undefined;
}): import("react").JSX.Element;
export declare function ChannelTalk({ d, edit }: {
    d: Draft;
    edit: Edit;
}): import("react").JSX.Element;
export declare function ChannelPrompts({ d, edit }: {
    d: Draft;
    edit: Edit;
}): import("react").JSX.Element;
export declare function CollectionBasics({ d, edit, accountId, latest }: {
    d: Draft;
    edit: Edit;
    accountId?: string | undefined;
    latest?: number | undefined;
}): import("react").JSX.Element;
/**
 * The manifest's fields the forms don't edit, as JSON (R-11): `selectors`, `shorthands` and
 * anything newer. Applied when it parses as an object.
 */
export declare function OtherFields({ d, edit, formKeys }: {
    d: Draft;
    edit: Edit;
    formKeys: readonly string[];
}): import("react").JSX.Element;
