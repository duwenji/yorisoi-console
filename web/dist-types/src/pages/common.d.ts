import { type ReactNode } from 'react';
/** Loads data once and on demand; shows errors in the operator's words. */
export declare function useLoad<T>(load: () => Promise<T | undefined>, deps: unknown[]): {
    data: T | undefined;
    error: string | undefined;
    loading: boolean;
    reload: () => void;
};
export declare function Time({ value }: {
    value: string | null | undefined;
}): import("react").JSX.Element;
export declare function Status({ error, loading }: {
    error?: string | undefined;
    loading?: boolean;
}): import("react").JSX.Element | null;
export declare function Empty({ children }: {
    children: ReactNode;
}): import("react").JSX.Element;
/**
 * A form that asks for a reason before a change (every operator action is recorded with one,
 * DM-001 AUDIT) and shows the outcome.
 */
export declare function ReasonForm({ label, submit, danger, children, }: {
    label: string;
    submit: (reason: string) => Promise<unknown>;
    danger?: boolean;
    children?: ReactNode;
}): import("react").JSX.Element;
export declare const reasons: (list: string[]) => string;
