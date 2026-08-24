"use client";
import type { ReactNode } from "react";
import { X } from "lucide-react";

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

  return <div
    className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm"
    onClick={onClose}
  >
    <div
      className="metal-panel w-full max-w-md rounded-2xl border border-metal-600 p-6 shadow-soft"
      onClick={e => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h3 className="font-bold text-metal-50">{title}</h3>
          {description && <p className="mt-1 text-sm text-metal-400">{description}</p>}
        </div>
        <button onClick={onClose} aria-label="Close" className="shrink-0 rounded-lg p-1 text-metal-400 hover:text-metal-100">
          <X size={18} />
        </button>
      </div>

      <div className="space-y-4">{children}</div>

      <div className="mt-6 flex justify-end gap-2">{footer}</div>
    </div>
  </div>;
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
  primary: "rounded-lg bg-leaf-500 px-4 py-2 text-sm font-semibold text-ink hover:bg-leaf-100 disabled:opacity-50",
  danger: "rounded-lg border border-red-400/30 px-4 py-2 text-sm font-semibold text-red-300 hover:bg-red-500/10"
};
