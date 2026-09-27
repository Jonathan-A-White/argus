import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CalendarRange,
  ChevronDown,
  ClipboardCheck,
  ExternalLink,
  History,
  KeyRound,
  LayoutGrid,
  Settings,
  ShieldCheck,
  Shirt,
  Users,
  Wallet,
  Wifi,
} from "lucide-react";
import {
  DistributedAppController,
  type ArgusAppProjection,
} from "./distributed/appIntegration";
import type {
  ArgusPermission,
  ArgusRole,
  StoredEvent,
} from "./distributed/types";
import { ROLE_PERMISSIONS } from "./auth/authorization";
import {
  LocalSettingsStorage,
  type SettingsStorage,
  type UserSettings,
} from "./settings";
import { resolveBlockchainMode } from "./blockchain/config";
import { SupplyWorkflow } from "./components/SupplyWorkflow";
import { Drawer, Summary } from "./components/Drawer";
import { SharedCountView } from "./features/count/SharedCountView";
import { InventoryCatalogView } from "./features/inventory/InventoryCatalogView";
import { CadetsView } from "./features/cadets/CadetsView";
import { ConflictsPanel } from "./features/conflicts/ConflictsPanel";
import { cadetLabel } from "./stage3/domain";
import { UnitGate } from "./unit/screens/UnitGate";
import { MembersPanel, WalletPanel } from "./unit/screens/UnitPanels";
import { roleLabel, syncLabel } from "./unit/screens/labels";
import type {
  UnitRuntime,
  UnitRuntimeOptions,
  UnitStatus,
} from "./unit/runtime";

export type Tab = "count" | "inventory" | "cadets" | "activity" | "more";
type Panel =
  | "cadet-issue"
  | "cadet-return"
  | "bundles"
  | "needed"
  | "members"
  | "wallet"
  | "conflicts"
  | "diagnostics"
  | null;
const nav: Array<{ id: Tab; label: string; icon: typeof Activity }> = [
  { id: "count", label: "Count", icon: ClipboardCheck },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "cadets", label: "Cadets", icon: Users },
  { id: "activity", label: "Activity", icon: History },
  { id: "more", label: "More", icon: LayoutGrid },
];
const pageTitle = (tab: Tab) =>
  ({
    count: "Shared Count",
    inventory: "Inventory",
    cadets: "Cadets",
    activity: "Activity",
    more: "Command Center",
  })[tab];

type Props = {
  /** Supplying a controller skips the unit gate (tests and mock-development demos). */
  controller?: DistributedAppController;
  settingsStorage?: SettingsStorage;
  runtimeOptions?: UnitRuntimeOptions;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

/**
 * The live app always goes through the unit gate: each person unlocks their own device key, and
 * the unit's shared data comes from BSV testnet. Only an explicit mock-development build (or a
 * test that passes a controller) runs the single-device demo.
 */
export default function App({
  controller,
  runtimeOptions,
  storage,
  ...rest
}: Props) {
  if (controller) return <AuthenticatedApp controller={controller} {...rest} />;
  if (
    resolveBlockchainMode(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE) ===
    "mock-development"
  )
    return <DemoApp {...rest} />;
  return (
    <UnitGate
      runtimeOptions={runtimeOptions}
      {...(storage ? { storage } : {})}
    >
      {(runtime, lock) => (
        <AuthenticatedApp
          controller={runtime.controller}
          runtime={runtime}
          onLock={lock}
          {...rest}
        />
      )}
    </UnitGate>
  );
}

function DemoApp(props: Omit<Props, "controller">) {
  const [controller] = useState(() => new DistributedAppController());
  return <AuthenticatedApp controller={controller} {...props} />;
}

type AuthenticatedAppProps = Omit<
  Props,
  "controller" | "runtimeOptions" | "storage"
> & {
  controller: DistributedAppController;
  runtime?: UnitRuntime;
  onLock?: () => void;
};

function AuthenticatedApp({
  controller,
  runtime,
  settingsStorage: suppliedSettings,
  onLock,
}: AuthenticatedAppProps) {
  const [settingsStorage] = useState(
    () => suppliedSettings ?? new LocalSettingsStorage(),
  );
  const [preferences, setPreferences] = useState<UserSettings>(() =>
    settingsStorage.load(),
  );
  const [projection, setProjection] = useState<ArgusAppProjection>();
  const [status, setStatus] = useState<UnitStatus | undefined>(() =>
    runtime?.status(),
  );
  const [tab, setTab] = useState<Tab>(preferences.defaultSection);
  const [panel, setPanel] = useState<Panel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [countItemId, setCountItemId] = useState<string>();
  const [workflowCadetId, setWorkflowCadetId] = useState<string>();

  useEffect(() => {
    let active = true,
      stopSync: undefined | (() => void);
    const stopProjection = runtime?.onProjection((next) => {
      if (active) setProjection(next);
    });
    const stopStatus = runtime?.onStatus((next) => {
      if (active) setStatus(next);
    });
    // A unit runtime was initialized by the gate; a bare controller (demo/tests) initializes here.
    (runtime ? controller.project() : controller.initialize())
      .then((p) => {
        if (!active) return;
        setProjection(p);
        stopSync = controller.startAutoSync((next) => {
          if (active) setProjection(next);
        });
      })
      .catch((e) =>
        setNotice(
          e instanceof Error ? e.message : "Local data could not be loaded.",
        ),
      );
    return () => {
      active = false;
      stopSync?.();
      stopProjection?.();
      stopStatus?.();
    };
  }, [controller, runtime]);
  useEffect(() => {
    settingsStorage.save(preferences);
    Object.assign(document.documentElement.dataset, {
      theme: preferences.theme,
      density: preferences.density,
      motion: preferences.motion,
      textSize: preferences.textSize,
    });
  }, [preferences, settingsStorage]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const role: ArgusRole | "PENDING" =
    runtime?.device.record.role ?? "SUPPLY_OFFICER";
  const can = useCallback(
    (permission: ArgusPermission) =>
      role !== "PENDING" && ROLE_PERMISSIONS[role].includes(permission),
    [role],
  );
  const memberName = useCallback(
    (publicIdentity: string) => {
      if (projection && publicIdentity === projection.actor) return "You";
      return (
        projection?.members.find(
          (member) => member.publicIdentity === publicIdentity,
        )?.displayName ?? "Unit member"
      );
    },
    [projection],
  );
  const notify = useCallback((message: string) => setNotice(message), []);
  const mode = runtime ? "testnet" : "mock";

  if (!projection)
    return (
      <main className="loading-state" aria-live="polite">
        <strong>Loading A.R.G.U.S.…</strong>
        {notice && <p role="alert">{notice}</p>}
      </main>
    );
  const syncText = projection.sync.openConflicts
    ? "CONFLICT · ACTION REQUIRED"
    : status
      ? syncLabel(status)
      : "MOCK · THIS DEVICE ONLY";
  const who = runtime?.device.record.displayName ?? "Demo user";
  const initialsOf = who
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const openCadetWorkflow = (
    kind: "cadet-issue" | "cadet-return",
    cadetId: string,
  ) => {
    setWorkflowCadetId(cadetId);
    setPanel(kind);
  };
  return (
    <div className="app-shell">
      <div className="aether-field" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary navigation">
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? "nav-item active" : "nav-item"}
              onClick={() => setTab(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="system-card">
          <span className="pulse" />
          <strong>
            {runtime ? runtime.device.record.unit?.unitName : "Demo unit"}
          </strong>
          <p>{syncText}</p>
        </div>
        <button className="profile" onClick={() => setSettingsOpen(true)}>
          <span className="avatar">{initialsOf}</span>
          <span>
            <strong>{who}</strong>
            <small>{roleLabel(role)}</small>
          </span>
          <ChevronDown size={16} />
        </button>
      </aside>
      <main className="main-stage">
        <div className={`environment-banner ${mode}`} role="note">
          <strong>{mode === "testnet" ? "BSV TESTNET" : "MOCK BLOCKCHAIN"}</strong>
          <span>Development Environment · No Production Transactions</span>
        </div>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {(
                runtime?.device.record.unit?.unitName ?? "A.R.G.U.S. demo"
              ).toUpperCase()}
            </p>
            <h1>{pageTitle(tab)}</h1>
          </div>
          <div className="top-actions">
            <button
              className="sync"
              onClick={() =>
                setPanel(
                  projection.sync.openConflicts
                    ? "conflicts"
                    : runtime
                      ? "wallet"
                      : null,
                )
              }
            >
              <Wifi size={15} />
              {syncText}
            </button>
            <button
              aria-label="Settings"
              className="icon-button"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={20} />
            </button>
            <span className="top-avatar">{initialsOf}</span>
          </div>
        </header>
        {notice && (
          <div className="app-notice" role="status">
            {notice}
          </div>
        )}
        {tab === "count" && (
          <SharedCountView
            key={countItemId ?? "count"}
            projection={projection}
            controller={controller}
            can={can}
            memberName={memberName}
            onProjection={setProjection}
            notify={notify}
            {...(countItemId ? { initialItemId: countItemId } : {})}
          />
        )}
        {tab === "inventory" && (
          <InventoryCatalogView
            projection={projection}
            controller={controller}
            can={can}
            onProjection={setProjection}
            notify={notify}
            onCount={(itemId) => {
              setCountItemId(itemId);
              setTab("count");
            }}
          />
        )}
        {tab === "cadets" && (
          <CadetsView
            projection={projection}
            controller={controller}
            can={can}
            onProjection={setProjection}
            notify={notify}
            onIssue={(cadetId) => openCadetWorkflow("cadet-issue", cadetId)}
            onReturn={(cadetId) => openCadetWorkflow("cadet-return", cadetId)}
          />
        )}
        {tab === "activity" && (
          <ActivityView
            projection={projection}
            memberName={memberName}
            runtime={runtime}
            status={status}
          />
        )}
        {tab === "more" && (
          <CommandCenter
            projection={projection}
            hasRuntime={Boolean(runtime)}
            open={setPanel}
            settings={() => setSettingsOpen(true)}
            lock={onLock}
          />
        )}
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            <Icon size={21} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {(panel === "cadet-issue" || panel === "cadet-return") && (
        <SupplyWorkflow
          mode={panel === "cadet-issue" ? "ISSUE" : "RETURN"}
          projection={projection}
          controller={controller}
          selectedCadetId={workflowCadetId}
          onClose={() => setPanel(null)}
          onChanged={setProjection}
        />
      )}
      {panel === "bundles" && (
        <BundlesPanel
          projection={projection}
          memberName={memberName}
          close={() => setPanel(null)}
        />
      )}
      {panel === "needed" && (
        <NeededPanel projection={projection} close={() => setPanel(null)} />
      )}
      {panel === "conflicts" && (
        <ConflictsPanel
          projection={projection}
          controller={controller}
          can={can}
          memberName={memberName}
          close={() => setPanel(null)}
          onProjection={setProjection}
          notify={notify}
        />
      )}
      {panel === "members" && runtime && (
        <MembersPanel
          runtime={runtime}
          projection={projection}
          close={() => setPanel(null)}
          onProjection={setProjection}
          notify={notify}
        />
      )}
      {panel === "wallet" && runtime && status && (
        <WalletPanel
          runtime={runtime}
          status={status}
          close={() => setPanel(null)}
          notify={notify}
        />
      )}
      {panel === "diagnostics" && (
        <DiagnosticsPanel
          projection={projection}
          close={() => setPanel(null)}
        />
      )}
      {settingsOpen && (
        <SettingsPanel
          value={preferences}
          change={setPreferences}
          close={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <img src={`${import.meta.env.BASE_URL}argus-mark.svg`} alt="" />
      <div>
        <strong>A.R.G.U.S.</strong>
        <span>ASSET READINESS SYSTEM</span>
      </div>
    </div>
  );
}

/** Plain-language description of one event. Cadets appear only by cadet ID; names never appear here. */
function describeEvent(
  projection: ArgusAppProjection,
  record: StoredEvent,
  memberName: (publicIdentity: string) => string,
) {
  const { event } = record,
    payload = event.payload;
  const item = (id: unknown) => {
    const found = projection.inventory.find((i) => i.entityId === id);
    return found ? `${found.name} · ${found.variant}` : "an item";
  };
  const session = projection.countSessions.find(
    (s) => s.sessionId === event.entityId,
  );
  const cadet = (id: unknown) => {
    const found = projection.cadets.find((c) => c.cadetId === id);
    return found ? cadetLabel(found) : "a cadet";
  };
  switch (event.eventType) {
    case "COUNT_CONTRIBUTED":
      return `Counted ${payload.quantity} × ${item(payload.itemId)}`;
    case "COUNT_CORRECTED":
      return `Corrected a count to ${payload.replacementQuantity}`;
    case "COUNT_SESSION_CREATED":
      return `Started shared count “${payload.scope}”`;
    case "COUNT_SESSION_RECONCILED":
      return `Finalized count “${session?.scope ?? "count"}” — on-hand updated`;
    case "COUNT_SESSION_CANCELLED":
      return `Cancelled count “${session?.scope ?? "count"}”`;
    case "INVENTORY_RECEIVED":
      return `Received ${payload.quantity} × ${item(event.entityId)}`;
    case "CATALOG_SIZES_ADDED": {
      const catalog = projection.catalog.find(
        (c) => c.catalogId === event.entityId,
      );
      const sizes = Array.isArray(payload.sizes)
        ? (payload.sizes as Array<{ label: string }>).map((s) => s.label)
        : [];
      return `Added sizes ${sizes.slice(0, 6).join(", ")}${sizes.length > 6 ? "…" : ""} to ${catalog?.name ?? "an item"}`;
    }
    case "CATALOG_ITEM_CREATED":
      return `Added catalog item ${String(payload.name)}`;
    case "CATALOG_ITEM_UPDATED":
    case "INVENTORY_ITEM_UPDATED":
      return `Updated item details`;
    case "CADET_CREATED":
      return `Added cadet ${cadet(event.entityId)}`;
    case "CADET_UPDATED":
      return `Updated cadet ${cadet(event.entityId)}`;
    case "ITEM_ISSUED":
    case "ITEM_RETURNED": {
      const applied = projection.transactions.some(
        (t) => t.eventId === event.eventId,
      );
      const quantity = Array.isArray(payload.lines)
        ? (payload.lines as Array<{ quantity: number }>).reduce(
            (sum, line) => sum + line.quantity,
            0,
          )
        : Number(payload.quantity ?? 0);
      const issued = event.eventType === "ITEM_ISSUED";
      return `${issued ? "Issued" : "Returned"} ${quantity} item${quantity === 1 ? "" : "s"} ${issued ? "to" : "from"} ${cadet(payload.cadetId)}${applied || !Array.isArray(payload.lines) ? "" : " (not applied — see conflicts)"}`;
    }
    case "AUTHORITY_GRANTED":
      return `Admitted ${String(payload.displayName)} as ${roleLabel(String((payload.credential as { role?: string } | undefined)?.role ?? ""))}`;
    case "AUTHORITY_REVOKED":
      return `Revoked access for ${memberName(event.entityId)}`;
    case "CONFLICT_RESOLVED":
      return "Resolved a conflict";
    default:
      return event.eventType.replaceAll("_", " ").toLowerCase();
  }
}
const statusText = (record: StoredEvent, rejected?: string) =>
  rejected
    ? "NOT APPLIED"
    : record.syncStatus === "SYNCHRONIZED"
      ? "VERIFIED"
      : record.syncStatus === "SYNCING"
        ? "PUBLISHING"
        : record.syncStatus;

function ActivityView({
  projection,
  memberName,
  runtime,
  status,
}: {
  projection: ArgusAppProjection;
  memberName: (publicIdentity: string) => string;
  runtime?: UnitRuntime;
  status?: UnitStatus;
}) {
  const events = [...projection.events].sort((a, b) =>
    a.event.timestamp < b.event.timestamp ? 1 : -1,
  );
  const rejected = new Map(
    projection.rejected.map((r) => [r.eventId, r.reason]),
  );
  return (
    <div className="content">
      <section className="page-intro">
        <div>
          <p className="eyebrow">AUDIT TRAIL</p>
          <h2>Nothing changes silently.</h2>
          <p>
            Every change is signed by the person who made it, encrypted, and
            written to the BSV testnet chain. VERIFIED means this device checked
            the signature and the person&apos;s role.
          </p>
        </div>
      </section>
      <section
        className="distributed-panel"
        aria-label="A.R.G.U.S. distributed system"
      >
        <strong>
          {runtime
            ? `SHARED ON BSV TESTNET · ${runtime.device.record.unit?.unitName ?? ""}`
            : "MOCK BLOCKCHAIN · THIS DEVICE ONLY"}
        </strong>
        <div>
          <span>
            <small>YOU</small>
            {runtime?.device.record.displayName ?? "Demo user"}
          </span>
          <span>
            <small>EVENTS</small>
            {projection.events.length}
          </span>
          <span>
            <small>WAITING TO PUBLISH</small>
            {status?.queued ?? projection.sync.outbox}
          </span>
          <span>
            <small>CONFLICTS</small>
            {projection.sync.openConflicts}
          </span>
          <span>
            <small>LOCAL COPY</small>Encrypted
          </span>
          {status && (
            <span>
              <small>HISTORY</small>
              <a
                href={`https://test.whatsonchain.com/address/${status.anchorAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                On chain <ExternalLink size={12} />
              </a>
            </span>
          )}
        </div>
      </section>
      <div className="timeline">
        {events.length ? (
          events.map((r) => (
            <div className="event" key={r.event.eventId}>
              <span className="event-icon">
                <Activity />
              </span>
              <div>
                <strong>{describeEvent(projection, r, memberName)}</strong>
                <p>
                  {memberName(r.event.actorPublicIdentity)} ·{" "}
                  <b>{statusText(r, rejected.get(r.event.eventId))}</b>
                  {rejected.get(r.event.eventId) &&
                    ` · ${rejected.get(r.event.eventId)}`}
                </p>
                <details className="audit-metadata">
                  <summary>Technical details</summary>
                  <span>
                    <b>Event</b>
                    {r.event.eventType} · {r.event.eventId}
                  </span>
                  <span>
                    <b>Signed by</b>
                    {r.event.actorPublicIdentity.slice(0, 24)}…
                  </span>
                  {r.transactionId && (
                    <span>
                      <b>Testnet transaction</b>
                      <a
                        href={`https://test.whatsonchain.com/tx/${r.transactionId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r.transactionId.slice(0, 16)}…
                      </a>
                    </span>
                  )}
                </details>
              </div>
              <time>{new Date(r.event.timestamp).toLocaleString()}</time>
            </div>
          ))
        ) : (
          <p className="empty-state">No changes recorded yet.</p>
        )}
      </div>
    </div>
  );
}

type CommandAction = [Exclude<Panel, null>, string, string, typeof Activity];
function CommandCenter({
  projection,
  hasRuntime,
  open,
  settings,
  lock,
}: {
  projection: ArgusAppProjection;
  hasRuntime: boolean;
  open: (p: Panel) => void;
  settings: () => void;
  lock?: () => void;
}) {
  const unitActions: CommandAction[] = hasRuntime
    ? [
        [
          "members",
          "Members & access",
          "Admit people with a join code, see who is in the unit",
          KeyRound,
        ],
        [
          "wallet",
          "Wallet & sync",
          "This device's testnet coins and chain sync status",
          Wallet,
        ],
      ]
    : [];
  const actions: CommandAction[] = [
    ...unitActions,
    [
      "conflicts",
      `Conflicts${projection.sync.openConflicts ? ` · ${projection.sync.openConflicts} open` : ""}`,
      "Competing offline changes that need a decision",
      AlertTriangle,
    ],
    ["bundles", "Issue bundles", "Bundle contents and version history", Shirt],
    [
      "needed",
      "Still needed",
      "Unfulfilled cadet requirements",
      ClipboardCheck,
    ],
    [
      "diagnostics",
      "Diagnostics",
      "Data integrity and records that could not be applied",
      ShieldCheck,
    ],
  ];
  return (
    <div className="content">
      <section className="page-intro">
        <div>
          <p className="eyebrow">OPERATIONS</p>
          <h2>Command Center</h2>
          <p>Administration, readiness, and system controls in one place.</p>
        </div>
      </section>
      <div className="command-grid">
        {actions.map(([id, title, detail, Icon]) => (
          <button key={id} onClick={() => open(id)}>
            <span>
              <Icon />
            </span>
            <div>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          </button>
        ))}
        <button onClick={settings}>
          <span>
            <Settings />
          </span>
          <div>
            <strong>Settings</strong>
            <p>Appearance and behavior on this device</p>
          </div>
        </button>
        {lock && (
          <button onClick={lock}>
            <span>
              <KeyRound />
            </span>
            <div>
              <strong>Lock this device</strong>
              <p>Clear decrypted data from memory and require the passphrase</p>
            </div>
          </button>
        )}
      </div>
      <p className="safe-note">
        <CalendarRange size={14} /> Planned next: supply calendar (NCO, BLT,
        AMI, Military Ball, End-of-Year), alerts, dashboard readiness tree,
        roster import and annual rollover.
      </p>
    </div>
  );
}

function BundlesPanel({
  projection,
  memberName,
  close,
}: {
  projection: ArgusAppProjection;
  memberName: (publicIdentity: string) => string;
  close: () => void;
}) {
  return (
    <Drawer title="Issue bundles" icon={<Shirt />} close={close}>
      {projection.bundles.map((b) => {
        const current = b.versions.find((v) => v.version === b.currentVersion)!;
        return (
          <details className="panel-rows" key={b.bundleId}>
            <summary>
              <strong>{current.displayName}</strong> · v{b.currentVersion} ·{" "}
              {current.active ? "ACTIVE" : "INACTIVE"}
              <small>
                {current.genderApplicability} · {b.mapping.mapped}/
                {b.mapping.total} lines ready to issue
              </small>
            </summary>
            <div>
              {[...current.lines]
                .sort((a, z) => a.order - z.order)
                .map((l) => {
                  const sizes = projection.inventory.filter(
                    (item) =>
                      (l.catalogId && item.catalogId === l.catalogId) ||
                      item.entityId === l.itemId,
                  );
                  return (
                    <p key={l.lineId}>
                      <b>{l.displayLabel}</b> ·{" "}
                      {l.required ? "Required" : "Optional"} ·{" "}
                      {sizes.length
                        ? `${sizes.length} size${sizes.length === 1 ? "" : "s"} configured`
                        : "No sizes configured yet (Inventory → item → Add sizes)"}
                    </p>
                  );
                })}
              <h4>Version history</h4>
              {[...b.versions].reverse().map((v) => (
                <p key={v.version}>
                  v{v.version}
                  {v.version === b.currentVersion ? " · CURRENT" : ""} ·{" "}
                  {v.actorPublicIdentity.startsWith("factory:")
                    ? "Default preset"
                    : `${new Date(v.createdAt).toLocaleDateString()} · ${memberName(v.actorPublicIdentity)}`}
                </p>
              ))}
            </div>
          </details>
        );
      })}
    </Drawer>
  );
}

function NeededPanel({
  projection,
  close,
}: {
  projection: ArgusAppProjection;
  close: () => void;
}) {
  const requirements = projection.stillNeeded,
    remaining = requirements.reduce(
      (sum, item) =>
        sum + Math.max(0, item.quantityNeeded - item.quantityFulfilled),
      0,
    ),
    ready = requirements.filter((item) => item.availability.available).length;
  return (
    <Drawer title="Still Needed" icon={<ClipboardCheck />} close={close}>
      <section className="needed-overview" aria-label="Requirement overview">
        <div>
          <small>OPEN REQUIREMENTS</small>
          <strong>{requirements.length}</strong>
          <span>
            Across {new Set(requirements.map((item) => item.cadetId)).size}{" "}
            cadets
          </span>
        </div>
        <div>
          <small>UNITS REMAINING</small>
          <strong>{remaining}</strong>
          <span>{ready} ready to issue</span>
        </div>
      </section>
      <div className="needed-list">
        {requirements.length ? (
          requirements.map((n) => {
            const count = Math.max(0, n.quantityNeeded - n.quantityFulfilled);
            const cadet = projection.cadets.find(
              (c) => c.cadetId === n.cadetId,
            );
            const code = cadet ? cadetLabel(cadet) : "Missing cadet";
            return (
              <article className="needed-card" key={n.requirementId}>
                <div className="needed-card-main">
                  <span className="needed-initials" aria-hidden="true">
                    {code.slice(2, 4)}
                  </span>
                  <div>
                    <strong>{code}</strong>
                    <p>
                      {n.displayLabel}
                      <span>·</span>
                      {n.size ?? "No size"}
                    </p>
                  </div>
                  <b
                    className="needed-quantity"
                    aria-label={`${count} remaining`}
                  >
                    {count}
                    <small>REMAINING</small>
                  </b>
                </div>
                <div className="needed-card-meta">
                  <span>
                    <CalendarRange />
                    First needed{" "}
                    <time dateTime={n.firstNeededAt}>
                      {new Date(n.firstNeededAt).toLocaleDateString()}
                    </time>
                  </span>
                  <em
                    className={
                      n.availability.available
                        ? "needed-status ready"
                        : "needed-status attention"
                    }
                  >
                    <span />
                    {!n.availability.configured
                      ? "Not configured"
                      : n.availability.available
                        ? `${n.availability.onHand} available`
                        : "Awaiting stock"}
                  </em>
                </div>
              </article>
            );
          })
        ) : (
          <p className="empty-state">
            <strong>All requirements fulfilled</strong>
            <span>No equipment is currently waiting to be issued.</span>
          </p>
        )}
      </div>
    </Drawer>
  );
}

function DiagnosticsPanel({
  projection,
  close,
}: {
  projection: ArgusAppProjection;
  close: () => void;
}) {
  const report = projection.integrity;
  return (
    <Drawer title="Diagnostics" icon={<ShieldCheck />} close={close}>
      <div className={report.healthy ? "validation" : "notice"}>
        <ShieldCheck />
        <div>
          <strong>
            {report.healthy ? "Data integrity healthy" : "Attention required"}
          </strong>
          <p>{report.issues.length} issues detected non-destructively.</p>
        </div>
      </div>
      <div className="panel-rows">
        <Summary
          label="Events"
          value={String(projection.events.length)}
          detail="Signed changes known to this device"
        />
        <Summary
          label="Not applied"
          value={String(projection.rejected.length)}
          detail="Kept, re-checked whenever new history arrives"
          accent={projection.rejected.length > 0}
        />
      </div>
      {projection.rejected.length > 0 && (
        <div className="panel-rows" aria-label="Records not applied">
          {projection.rejected.map((r) => (
            <p key={r.eventId}>
              <b>{r.eventType.replaceAll("_", " ").toLowerCase()}</b> ·{" "}
              {r.reason}
            </p>
          ))}
        </div>
      )}
      <p>A.R.G.U.S. version {__APP_VERSION__}</p>
    </Drawer>
  );
}

function SettingsPanel({
  value,
  change,
  close,
}: {
  value: UserSettings;
  change: (v: UserSettings) => void;
  close: () => void;
}) {
  const set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) =>
    change({ ...value, [k]: v });
  return (
    <Drawer title="Settings" icon={<Settings />} close={close}>
      <h3>Appearance</h3>
      <label className="field">
        THEME
        <select
          aria-label="Appearance"
          value={value.theme}
          onChange={(e) =>
            set("theme", e.target.value as UserSettings["theme"])
          }
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className="field">
        DENSITY
        <select
          aria-label="Density"
          value={value.density}
          onChange={(e) =>
            set("density", e.target.value as UserSettings["density"])
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </label>
      <label className="field">
        MOTION
        <select
          aria-label="Motion"
          value={value.motion}
          onChange={(e) =>
            set("motion", e.target.value as UserSettings["motion"])
          }
        >
          <option value="full">Full</option>
          <option value="reduced">Reduced</option>
        </select>
      </label>
      <label className="field">
        TEXT SIZE
        <select
          aria-label="Text size"
          value={value.textSize}
          onChange={(e) =>
            set("textSize", e.target.value as UserSettings["textSize"])
          }
        >
          <option value="standard">Standard</option>
          <option value="large">Large</option>
        </select>
      </label>
      <label className="field">
        DEFAULT SECTION
        <select
          aria-label="Default section"
          value={value.defaultSection}
          onChange={(e) => set("defaultSection", e.target.value as Tab)}
        >
          {nav.map((n) => (
            <option key={n.id} value={n.id}>
              {pageTitle(n.id)}
            </option>
          ))}
        </select>
      </label>
      <p>A.R.G.U.S. version {__APP_VERSION__}</p>
    </Drawer>
  );
}
