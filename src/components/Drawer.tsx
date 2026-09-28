import { useRef } from "react";
import { X } from "lucide-react";
import { useModalDialog } from "./modal";

/**
 * Modal side panel used by every A.R.G.U.S. workflow. Escape, a backdrop click or the close
 * button closes it; focus moves in, stays in while it is open, and returns to the opener.
 */
export function Drawer({
  title,
  icon,
  close,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  close: () => void;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(dialog, close);
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <aside
        ref={dialog}
        className="demo-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <span className="drawer-icon">{icon}</span>
          <div>
            <small>A.R.G.U.S. COMMAND PANEL</small>
            <h2>{title}</h2>
          </div>
          <button
            className="drawer-close"
            aria-label="Close panel"
            onClick={close}
          >
            <X />
          </button>
        </header>
        {children}
      </aside>
    </div>
  );
}

export function Summary({
  label,
  value,
  detail,
  accent = false,
}: {
  label: string;
  value: string;
  detail: string;
  accent?: boolean;
}) {
  return (
    <div className={accent ? "summary-card accent" : "summary-card"}>
      <small>{label.toUpperCase()}</small>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}
