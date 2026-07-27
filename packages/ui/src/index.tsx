import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export type IconName =
  | "activity"
  | "alert"
  | "arrow-down"
  | "arrow-left"
  | "arrow-up"
  | "branch"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "clock"
  | "close"
  | "code"
  | "copy"
  | "download"
  | "edit"
  | "file"
  | "folder"
  | "home"
  | "info"
  | "layers"
  | "menu"
  | "message"
  | "more"
  | "paperclip"
  | "pin"
  | "play"
  | "plus"
  | "refresh"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "spark"
  | "square"
  | "stop"
  | "target"
  | "terminal"
  | "trash"
  | "user"
  | "wifi-off";

const iconPaths: Record<IconName, ReactNode> = {
  activity: <path d="M3 12h4l2.4-7 4.2 14 2.2-7H21" />,
  alert: (
    <>
      <path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4m0 3.5v.01" />
    </>
  ),
  "arrow-down": <path d="M12 4v16m-6-6 6 6 6-6" />,
  "arrow-left": <path d="m15 18-6-6 6-6" />,
  "arrow-up": <path d="M12 20V4m-6 6 6-6 6 6" />,
  branch: (
    <>
      <circle cx="6" cy="4" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="6" cy="20" r="2" />
      <path d="M6 6v12M8 8h4a6 6 0 0 0 6-6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  code: <path d="m9 18-6-6 6-6m6 0 6 6-6 6" />,
  copy: (
    <>
      <rect height="13" rx="2" width="13" x="8" y="8" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </>
  ),
  download: <path d="M12 3v12m-5-5 5 5 5-5M5 21h14" />,
  edit: <path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Zm10.5-12 2.8 2.8" />,
  file: <path d="M6 2h8l4 4v16H6zM14 2v5h4" />,
  folder: <path d="M3 6h7l2 2h9v11H3z" />,
  home: <path d="m3 11 9-8 9 8v10h-6v-7H9v7H3z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v.01" />
    </>
  ),
  layers: <path d="m12 2 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  message: <path d="M4 4h16v13H9l-5 4z" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  paperclip: <path d="m20 11-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 1 1-3-3l8-8" />,
  pin: <path d="m14 4 6 6-3 1-4 4 .5 4.5-1.5 1.5-3-5-5-3L5.5 11l4.5.5 4-4zM8 16l-5 5" />,
  play: <path d="m8 5 11 7-11 7z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  refresh: (
    <path d="M20 7v5h-5M4 17v-5h5M6.1 8a7 7 0 0 1 11.6-2L20 8M4 16l2.3 2a7 7 0 0 0 11.6-2" />
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  send: <path d="m22 2-7 20-4-9-9-4zM11 13 22 2" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
  shield: <path d="M12 2 4 5v6c0 5.4 3.4 9.1 8 11 4.6-1.9 8-5.6 8-11V5zM8.5 12l2.2 2.2 4.8-5" />,
  spark: (
    <path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7L12 2Zm7 13 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
  ),
  square: <rect x="5" y="5" width="14" height="14" rx="2" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
    </>
  ),
  terminal: <path d="m4 6 5 5-5 5m8 1h8" />,
  trash: <path d="M4 7h16M9 7V4h6v3m-8 0 1 14h8l1-14M10 11v6m4-6v6" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  "wifi-off": (
    <path d="m2 2 20 20M8.5 8.5A11 11 0 0 1 21 9M3 9a16 16 0 0 1 2.2-1.4M6 13a10 10 0 0 1 7-2.8M10 17a4 4 0 0 1 6.4.5M12 21h.01" />
  ),
};

export function Icon({
  name,
  size = 20,
  className,
  label,
}: {
  name: IconName;
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={className}
      fill="none"
      height={size}
      role={label ? "img" : undefined}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {iconPaths[name]}
    </svg>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "regular" | "compact" | "icon";
  icon?: IconName;
};

export function Button({
  variant = "secondary",
  size = "regular",
  icon,
  children,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`}
      data-touch-target="primary"
      {...props}
    >
      {icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  );
}

export function Card({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`ui-card ${className}`} {...props}>
      {children}
    </div>
  );
}

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export function StatusPill({
  tone = "neutral",
  children,
  dot = true,
  className = "",
}: {
  tone?: StatusTone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span className={`ui-status ui-status--${tone} ${className}`}>
      {dot ? <span aria-hidden="true" className="ui-status__dot" /> : null}
      {children}
    </span>
  );
}

export function Progress({
  value,
  tone = "success",
  label,
}: {
  value?: number | undefined;
  tone?: StatusTone;
  label: string;
}) {
  const safeValue = value === undefined ? undefined : Math.max(0, Math.min(100, value));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={safeValue}
      className={`ui-progress ui-progress--${tone}`}
      role="progressbar"
    >
      <span style={safeValue === undefined ? undefined : { width: `${safeValue}%` }} />
    </div>
  );
}

export function EmptyState({
  icon = "spark",
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="ui-empty">
      <span className="ui-empty__icon">
        <Icon name={icon} size={24} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Skeleton({ width = "100%" }: { width?: string }) {
  return <span aria-hidden="true" className="ui-skeleton" style={{ width }} />;
}

export function Sheet({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string | undefined;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode | undefined;
}) {
  if (!open) return null;
  return (
    <div className="ui-sheet-layer">
      <button aria-label="关闭抽屉" className="ui-sheet-backdrop" onClick={onClose} />
      <section
        aria-describedby={description ? "ui-sheet-description" : undefined}
        aria-modal="true"
        className="ui-sheet"
        role="dialog"
      >
        <div className="ui-sheet__handle" />
        <header>
          <div>
            <h2>{title}</h2>
            {description ? <p id="ui-sheet-description">{description}</p> : null}
          </div>
          <Button aria-label="关闭" icon="close" onClick={onClose} size="icon" variant="ghost" />
        </header>
        <div className="ui-sheet__body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  );
}
