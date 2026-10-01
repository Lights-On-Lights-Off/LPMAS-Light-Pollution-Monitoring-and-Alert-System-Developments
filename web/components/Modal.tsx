// components/Modal.tsx
"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function DialogFrame({ children, onClose, title, className = "" }: {children: ReactNode; onClose: () => void; title: string; className?: string}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => [...root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')].filter(el => el.getClientRects().length > 0);
    (focusable()[0] ?? root).focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {event.preventDefault(); closeRef.current();}
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {event.preventDefault();root.focus();return;}
      if (event.shiftKey && (document.activeElement === items[0] || document.activeElement === root)) {event.preventDefault();items[items.length-1].focus();}
      else if (!event.shiftKey && document.activeElement === items[items.length-1]) {event.preventDefault();items[0].focus();}
    }
    root.addEventListener("keydown",key);
    return () => {root.removeEventListener("keydown",key);document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  return <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={className} onClick={event => {if(event.target === event.currentTarget) onClose();}}>{children}</div>;
}
export function useConfirm() {
  const [prompt,setPrompt] = useState<string|null>(null);
  const resolve = useRef<((value: boolean) => void)|null>(null);
  useEffect(() => () => {resolve.current?.(false);},[]);
  const finish = (value: boolean) => {resolve.current?.(value);resolve.current=null;setPrompt(null);};
  return {
    confirm: (message: string) => new Promise<boolean>(done => {resolve.current=done;setPrompt(message);}),
    dialog: <Modal open={prompt !== null} onClose={() => finish(false)} title="Confirm action" footer={<><button className={modalButtonClass.secondary} onClick={() => finish(false)}>Cancel</button><button className={modalButtonClass.danger} onClick={() => finish(true)}>Confirm</button></>}><p className="text-theme-text">{prompt}</p></Modal>,
  };
}

export function Modal({
  open, onClose, title, description, children, footer
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  if (!open) return null;

  return <DialogFrame title={title} onClose={onClose}
    className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-sm"
  >
    {/* max-h-[85vh] + flex column + overflow-y-auto on the body: on a short
        mobile viewport (small Android phones, or the keyboard eating half the
        screen) a modal with a long form used to overflow past the bottom of
        the screen with no way to reach the footer buttons. Now the header and
        footer stay put and only the middle content scrolls. */}
    <div
      className="metal-panel flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-metal-600 p-5 shadow-soft sm:p-6"
      onClick={e => e.stopPropagation()}
    >
      <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-bold text-metal-50">{title}</h3>
          {description && <p className="mt-1 text-sm text-metal-400">{description}</p>}
        </div>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded-lg p-1 text-metal-400 hover:text-metal-100">
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">{children}</div>

      <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-2">{footer}</div>
    </div>
  </DialogFrame>;
}

// Shared field wrapper so every modal form looks identical
export function ModalField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block">
    <span className="mb-1.5 block text-sm font-semibold text-metal-200">{label}</span>
    {children}
  </label>;
}

export const modalButtonClass = {
  secondary: "rounded-lg border border-metal-600 px-4 py-2 text-sm font-semibold text-metal-300 hover:text-metal-100",
  primary: "rounded-lg bg-theme-accent px-4 py-2 text-sm font-semibold text-theme-accent-foreground hover:bg-theme-accent-hover disabled:opacity-50",
  danger: "rounded-lg border border-red-400/30 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10"
};