import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Database } from "bun:sqlite";

import type { ResolvedVpnDriver, VpnCleanupPolicy } from "#shared/prerequisites/types";

const SCHEMA_VERSION = 2;
const DATABASE_NAME = "state.sqlite";
const ALLOWED_FILES = new Set([DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]);
const QUIESCENCE_HINT =
  "Stop all agent-tools processes, then remove this VPN state directory before retrying.";

export type VpnLifecycle =
  | "DOWN"
  | "EXTERNAL"
  | "CHECKING"
  | "STARTING"
  | "ACTIVE"
  | "IDLE"
  | "STOPPING"
  | "UNKNOWN";
export type VpnLeaseStatus = "PENDING" | "ACTIVE";
export type VpnOperationKind = "CHECK" | "START" | "STOP";

export type SanitizedVpnDriver =
  | { readonly type: "macos-scutil"; readonly platform: "darwin"; readonly serviceName: string }
  | { readonly type: "linux-nmcli"; readonly platform: "linux"; readonly connectionName: string }
  | { readonly type: "windows-rasdial"; readonly platform: "win32"; readonly entryName: string };

export type VpnStateSnapshot = {
  readonly lifecycle: VpnLifecycle;
  readonly managedEpochId: string | null;
  readonly operationId: string | null;
  readonly operationKind: VpnOperationKind | null;
  readonly operationToken: string | null;
  readonly operationPid: number | null;
  readonly revision: number;
  readonly idleDeadline: number | null;
  readonly evidence: string | null;
  readonly adoptExternalAfterStart: boolean;
  readonly updatedAt: number;
  readonly pendingLeases: number;
  readonly activeLeases: number;
};

export type OperationGuard = {
  readonly operationId: string;
  readonly token: string;
  readonly revision: number;
};

type StateRow = {
  lifecycle: VpnLifecycle;
  managed_epoch_id: string | null;
  operation_id: string | null;
  operation_kind: VpnOperationKind | null;
  operation_token: string | null;
  operation_pid: number | null;
  revision: number;
  idle_deadline: number | null;
  evidence: string | null;
  adopt_external_after_start: number;
  updated_at: number;
};

type CountRow = { pending: number; active: number };
type MetadataRow = { driver_identity: string };

export class VpnStoreError extends Error {
  readonly hint = QUIESCENCE_HINT;

  constructor(message: string, options?: ErrorOptions) {
    super(`${message} ${QUIESCENCE_HINT}`, options);
    this.name = "VpnStoreError";
  }
}

export const sanitizeVpnDriver = (driver: ResolvedVpnDriver): SanitizedVpnDriver => {
  if (driver.type === "macos-scutil") {
    return { type: driver.type, platform: driver.platform, serviceName: driver.serviceName };
  }
  if (driver.type === "linux-nmcli") {
    return { type: driver.type, platform: driver.platform, connectionName: driver.connectionName };
  }
  return { type: driver.type, platform: driver.platform, entryName: driver.entryName };
};

export const canonicalDriverIdentity = (driver: SanitizedVpnDriver): string => {
  if (driver.type === "macos-scutil") {
    return JSON.stringify({
      platform: driver.platform,
      serviceName: driver.serviceName,
      type: driver.type,
    });
  }
  if (driver.type === "linux-nmcli") {
    return JSON.stringify({
      connectionName: driver.connectionName,
      platform: driver.platform,
      type: driver.type,
    });
  }
  return JSON.stringify({
    entryName: driver.entryName,
    platform: driver.platform,
    type: driver.type,
  });
};

const runtimeRoot = (override?: string) =>
  resolve(override ?? process.env.AGENT_TOOLS_RUNTIME_DIR ?? `${homedir()}/.agent-tools/runtime`);

export const getVpnStoreLocation = (driver: SanitizedVpnDriver, root?: string) => {
  const identity = canonicalDriverIdentity(driver);
  const key = createHash("sha256").update(identity).digest("hex");
  const base = runtimeRoot(root);
  return {
    identity,
    root: base,
    directory: resolve(base, "vpn-prerequisites", key),
    databasePath: resolve(base, "vpn-prerequisites", key, DATABASE_NAME),
  };
};

const ensurePrivateDirectory = (path: string) => {
  mkdirSync(path, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
    const stats = statSync(path);
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new VpnStoreError(`VPN runtime directory is owned by another user: ${path}.`);
    }
  }
  return realpathSync(path);
};

const assertNoLegacyArtifacts = (vpnRoot: string) => {
  const legacy = readdirSync(vpnRoot, { withFileTypes: true }).flatMap((entry) => {
    const directory = resolve(vpnRoot, entry.name);
    if (!entry.isDirectory() && !statSync(directory).isDirectory()) return [];
    return readdirSync(directory)
      .filter((name) => name === "started.json" || name === "lock" || /^lease-.*\.json$/.test(name))
      .map((name) => `${entry.name}/${name}`);
  });
  if (legacy.length > 0) {
    throw new VpnStoreError(
      `Legacy or mixed VPN runtime artifacts found in ${vpnRoot}: ${legacy.join(", ")}.`,
    );
  }
};

const secureDatabaseFiles = (directory: string) => {
  if (process.platform === "win32") return;
  for (const name of ALLOWED_FILES) {
    const path = resolve(directory, name);
    if (existsSync(path)) chmodSync(path, 0o600);
  }
};

const getUserVersion = (db: Database) =>
  db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? -1;

const initializeSchema = (db: Database, identity: string, now: number) => {
  db.exec(`
    CREATE TABLE metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      driver_identity TEXT NOT NULL
    ) STRICT;
    CREATE TABLE vpn_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('DOWN','EXTERNAL','CHECKING','STARTING','ACTIVE','IDLE','STOPPING','UNKNOWN')),
      managed_epoch_id TEXT,
      operation_id TEXT,
      operation_kind TEXT CHECK (operation_kind IS NULL OR operation_kind IN ('CHECK','START','STOP')),
      operation_token TEXT,
      operation_pid INTEGER CHECK (operation_pid IS NULL OR operation_pid > 0),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      idle_deadline INTEGER CHECK (idle_deadline IS NULL OR idle_deadline >= 0),
      evidence TEXT,
      adopt_external_after_start INTEGER NOT NULL DEFAULT 0 CHECK (adopt_external_after_start IN (0, 1)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK ((lifecycle IN ('CHECKING','STARTING','STOPPING')) = (operation_id IS NOT NULL)),
      CHECK ((operation_id IS NULL) = (operation_kind IS NULL)),
      CHECK ((operation_id IS NULL) = (operation_token IS NULL)),
      CHECK ((operation_id IS NULL) = (operation_pid IS NULL)),
      CHECK ((lifecycle IN ('ACTIVE','IDLE','STOPPING')) = (managed_epoch_id IS NOT NULL)),
      CHECK ((lifecycle = 'IDLE') = (idle_deadline IS NOT NULL)),
      CHECK (adopt_external_after_start = 0 OR lifecycle = 'STARTING')
    ) STRICT;
    CREATE TABLE leases (
      lease_id TEXT PRIMARY KEY,
      guardian_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE')),
      cleanup TEXT NOT NULL CHECK (cleanup IN ('leave-running','stop-if-started')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    ) STRICT;
  `);
  db.query("INSERT INTO metadata(singleton, driver_identity) VALUES (1, ?)").run(identity);
  db.query(
    "INSERT INTO vpn_state(singleton, lifecycle, revision, updated_at) VALUES (1, 'DOWN', 0, ?)",
  ).run(now);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
};

export class VpnStore {
  private constructor(
    private readonly db: Database,
    readonly directory: string,
    readonly databasePath: string,
  ) {}

  static open(driver: SanitizedVpnDriver, options?: { root?: string; now?: number }): VpnStore {
    const location = getVpnStoreLocation(driver, options?.root);
    try {
      ensurePrivateDirectory(location.root);
      const vpnRoot = ensurePrivateDirectory(resolve(location.root, "vpn-prerequisites"));
      assertNoLegacyArtifacts(vpnRoot);
      const directory = ensurePrivateDirectory(location.directory);
      const entries = readdirSync(directory);
      const legacy = entries.filter((entry) => !ALLOWED_FILES.has(entry));
      if (legacy.length > 0) {
        throw new VpnStoreError(
          `Legacy or mixed VPN runtime artifacts found in ${directory}: ${legacy.join(", ")}.`,
        );
      }

      const existed = existsSync(location.databasePath);
      const db = new Database(location.databasePath, {
        create: true,
        readwrite: true,
        strict: true,
      });
      secureDatabaseFiles(directory);
      try {
        db.exec("PRAGMA busy_timeout = 1000");
        if (existed) {
          const integrity = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get();
          if (integrity?.quick_check !== "ok") {
            throw new VpnStoreError(`VPN state database is corrupt: ${location.databasePath}.`);
          }
        }
        const version = getUserVersion(db);
        if (version === 0 && !existed) {
          initializeSchema(db, location.identity, options?.now ?? Date.now());
        } else if (version !== SCHEMA_VERSION) {
          throw new VpnStoreError(
            `Unsupported VPN state schema version ${version} at ${location.databasePath}.`,
          );
        }
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = FULL");
        db.exec("PRAGMA foreign_keys = ON");
        const metadata = db
          .query<MetadataRow, []>("SELECT driver_identity FROM metadata WHERE singleton = 1")
          .get();
        if (!metadata || metadata.driver_identity !== location.identity) {
          throw new VpnStoreError(
            `VPN state driver identity mismatch at ${location.databasePath}.`,
          );
        }
        secureDatabaseFiles(directory);
        return new VpnStore(db, directory, location.databasePath);
      } catch (error) {
        db.close(false);
        throw error;
      }
    } catch (error) {
      if (error instanceof VpnStoreError) throw error;
      throw new VpnStoreError(`Cannot open VPN state database at ${location.databasePath}.`, {
        cause: error,
      });
    }
  }

  close() {
    secureDatabaseFiles(this.directory);
    this.db.close(false);
  }

  settings() {
    return {
      journalMode: this.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()
        ?.journal_mode,
      synchronous: this.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()
        ?.synchronous,
      userVersion: this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version,
    };
  }

  private immediate<A>(operation: () => A): A {
    try {
      return this.db.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof VpnStoreError) throw error;
      throw new VpnStoreError(`VPN state transaction failed at ${this.databasePath}.`, {
        cause: error,
      });
    } finally {
      secureDatabaseFiles(this.directory);
    }
  }

  snapshot(): VpnStateSnapshot {
    try {
      const state = this.db
        .query<StateRow, []>("SELECT * FROM vpn_state WHERE singleton = 1")
        .get();
      const counts = this.db
        .query<CountRow, []>(
          "SELECT sum(status = 'PENDING') AS pending, sum(status = 'ACTIVE') AS active FROM leases",
        )
        .get();
      if (!state) throw new VpnStoreError(`VPN state row is missing at ${this.databasePath}.`);
      return {
        lifecycle: state.lifecycle,
        managedEpochId: state.managed_epoch_id,
        operationId: state.operation_id,
        operationKind: state.operation_kind,
        operationToken: state.operation_token,
        operationPid: state.operation_pid,
        revision: state.revision,
        idleDeadline: state.idle_deadline,
        evidence: state.evidence,
        adoptExternalAfterStart: state.adopt_external_after_start === 1,
        updatedAt: state.updated_at,
        pendingLeases: counts?.pending ?? 0,
        activeLeases: counts?.active ?? 0,
      };
    } catch (error) {
      if (error instanceof VpnStoreError) throw error;
      throw new VpnStoreError(`Cannot read VPN state at ${this.databasePath}.`, { cause: error });
    }
  }

  reserveLease(input: {
    leaseId: string;
    guardianId: string;
    ownerPid: number;
    cleanup: VpnCleanupPolicy;
    now: number;
  }): VpnStateSnapshot {
    return this.immediate(() => {
      this.db
        .query(
          `INSERT INTO leases(lease_id, guardian_id, owner_pid, status, cleanup, created_at, updated_at)
           VALUES (?, ?, ?, 'PENDING', ?, ?, ?)
           ON CONFLICT(lease_id) DO UPDATE SET guardian_id=excluded.guardian_id,
             owner_pid=excluded.owner_pid, cleanup=excluded.cleanup, updated_at=excluded.updated_at`,
        )
        .run(input.leaseId, input.guardianId, input.ownerPid, input.cleanup, input.now, input.now);
      this.db
        .query(
          `UPDATE vpn_state SET lifecycle='ACTIVE', idle_deadline=NULL,
             revision=revision+1, updated_at=? WHERE singleton=1 AND lifecycle='IDLE'`,
        )
        .run(input.now);
      return this.snapshot();
    });
  }

  activateLease(leaseId: string, guardianId: string, now: number): boolean {
    return this.immediate(
      () =>
        this.db
          .query(
            `UPDATE leases SET status='ACTIVE', updated_at=?
             WHERE lease_id=? AND guardian_id=? AND status='PENDING'`,
          )
          .run(now, leaseId, guardianId).changes === 1,
    );
  }

  claimCheck(
    operationId: string,
    token: string,
    ownerPid: number,
    now: number,
  ): OperationGuard | undefined {
    return this.claimOperation("DOWN", "CHECKING", "CHECK", operationId, token, ownerPid, now);
  }

  claimExternalCheck(
    operationId: string,
    token: string,
    ownerPid: number,
    now: number,
  ): OperationGuard | undefined {
    return this.claimOperation("EXTERNAL", "CHECKING", "CHECK", operationId, token, ownerPid, now);
  }

  claimStart(
    operationId: string,
    token: string,
    ownerPid: number,
    now: number,
  ): OperationGuard | undefined {
    return this.claimOperation("DOWN", "STARTING", "START", operationId, token, ownerPid, now);
  }

  private claimOperation(
    from: VpnLifecycle,
    to: VpnLifecycle,
    kind: VpnOperationKind,
    operationId: string,
    token: string,
    ownerPid: number,
    now: number,
  ): OperationGuard | undefined {
    return this.immediate(() => {
      const result = this.db
        .query(
          `UPDATE vpn_state SET lifecycle=?, operation_id=?, operation_kind=?, operation_token=?,
             operation_pid=?, revision=revision+1, idle_deadline=NULL, updated_at=?
           WHERE singleton=1 AND lifecycle=? AND operation_id IS NULL
             AND EXISTS (SELECT 1 FROM leases WHERE status='PENDING')`,
        )
        .run(to, operationId, kind, token, ownerPid, now, from);
      if (result.changes !== 1) return undefined;
      const state = this.snapshot();
      return { operationId, token, revision: state.revision };
    });
  }

  claimStop(
    operationId: string,
    token: string,
    ownerPid: number,
    now: number,
  ): OperationGuard | undefined {
    return this.immediate(() => {
      const result = this.db
        .query(
          `UPDATE vpn_state SET lifecycle='STOPPING', operation_id=?, operation_kind='STOP',
             operation_token=?, operation_pid=?, revision=revision+1, idle_deadline=NULL, updated_at=?
           WHERE singleton=1 AND lifecycle='IDLE' AND idle_deadline <= ?
             AND NOT EXISTS (SELECT 1 FROM leases)`,
        )
        .run(operationId, token, ownerPid, now, now);
      if (result.changes !== 1) return undefined;
      const state = this.snapshot();
      return { operationId, token, revision: state.revision };
    });
  }

  commitCheck(guard: OperationGuard, connected: boolean, now: number): boolean {
    return this.commitOperation(
      guard,
      "CHECKING",
      connected ? "EXTERNAL" : "DOWN",
      null,
      connected
        ? "Connected before agent-tools ownership was established."
        : "Confirmed disconnected.",
      now,
    );
  }

  commitStart(
    guard: OperationGuard,
    result: "managed" | "external" | "down" | "unknown",
    managedEpochId: string,
    evidence: string,
    now: number,
  ): boolean {
    const lifecycle =
      result === "managed"
        ? "ACTIVE"
        : result === "external"
          ? "EXTERNAL"
          : result === "down"
            ? "DOWN"
            : "UNKNOWN";
    return this.commitOperation(
      guard,
      "STARTING",
      lifecycle,
      result === "managed" ? managedEpochId : null,
      evidence,
      now,
    );
  }

  commitStop(guard: OperationGuard, disconnected: boolean, evidence: string, now: number): boolean {
    return this.commitOperation(
      guard,
      "STOPPING",
      disconnected ? "DOWN" : "UNKNOWN",
      null,
      evidence,
      now,
    );
  }

  reconcileOperation(
    snapshot: VpnStateSnapshot,
    connected: boolean | undefined,
    now: number,
  ): boolean {
    if (!snapshot.operationId || !snapshot.operationToken) return false;
    const guard = {
      operationId: snapshot.operationId,
      token: snapshot.operationToken,
      revision: snapshot.revision,
    };
    if (snapshot.lifecycle === "CHECKING") {
      if (connected === undefined) {
        return this.commitOperation(
          guard,
          "CHECKING",
          "UNKNOWN",
          null,
          "Stale status check was unparseable.",
          now,
        );
      }
      return this.commitCheck(guard, connected, now);
    }
    if (snapshot.lifecycle === "STARTING" || snapshot.lifecycle === "STOPPING") {
      return this.commitOperation(
        guard,
        snapshot.lifecycle,
        "UNKNOWN",
        null,
        `Stale ${snapshot.operationKind?.toLowerCase()} command completion and ownership are ambiguous; no retry is authorized.`,
        now,
      );
    }
    return false;
  }

  private commitOperation(
    guard: OperationGuard,
    from: VpnLifecycle,
    to: VpnLifecycle,
    managedEpochId: string | null,
    evidence: string,
    now: number,
  ): boolean {
    return this.immediate(
      () =>
        this.db
          .query(
            `UPDATE vpn_state SET
               lifecycle=CASE WHEN ?='ACTIVE' AND adopt_external_after_start=1 THEN 'EXTERNAL' ELSE ? END,
               managed_epoch_id=CASE WHEN ?='ACTIVE' AND adopt_external_after_start=1 THEN NULL ELSE ? END,
               operation_id=NULL, operation_kind=NULL, operation_token=NULL, operation_pid=NULL,
               revision=revision+1, idle_deadline=NULL, evidence=?, adopt_external_after_start=0,
               updated_at=?
             WHERE singleton=1 AND lifecycle=? AND operation_id=? AND operation_token=? AND revision=?`,
          )
          .run(
            to,
            to,
            to,
            managedEpochId,
            evidence,
            now,
            from,
            guard.operationId,
            guard.token,
            guard.revision,
          ).changes === 1,
    );
  }

  releaseLease(input: {
    leaseId: string;
    guardianId: string;
    idleDisconnectMs: number;
    now: number;
  }): { released: boolean; deadline: number | null } {
    return this.immediate(() => {
      const lease = this.db
        .query<{ cleanup: VpnCleanupPolicy }, [string, string]>(
          "SELECT cleanup FROM leases WHERE lease_id=? AND guardian_id=?",
        )
        .get(input.leaseId, input.guardianId);
      if (!lease) return { released: false, deadline: this.snapshot().idleDeadline };
      this.db
        .query("DELETE FROM leases WHERE lease_id=? AND guardian_id=?")
        .run(input.leaseId, input.guardianId);
      const remaining =
        this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM leases").get()?.count ??
        0;
      if (lease.cleanup === "leave-running") {
        this.db
          .query(
            `UPDATE vpn_state SET adopt_external_after_start=1,
               evidence='Leave-running adoption retained during managed VPN start.', updated_at=?
             WHERE singleton=1 AND lifecycle='STARTING'`,
          )
          .run(input.now);
        this.db
          .query(
            `UPDATE vpn_state SET lifecycle='EXTERNAL', managed_epoch_id=NULL, idle_deadline=NULL,
               operation_id=NULL, operation_kind=NULL, operation_token=NULL, operation_pid=NULL,
               adopt_external_after_start=0, revision=revision+1,
               evidence='Managed VPN adopted by leave-running lease.', updated_at=?
             WHERE singleton=1 AND lifecycle IN ('ACTIVE','IDLE')`,
          )
          .run(input.now);
      } else if (remaining === 0) {
        this.db
          .query(
            `UPDATE vpn_state SET lifecycle='IDLE', idle_deadline=?, revision=revision+1, updated_at=?
             WHERE singleton=1 AND lifecycle='ACTIVE'`,
          )
          .run(input.now + input.idleDisconnectMs, input.now);
      }
      return { released: true, deadline: this.snapshot().idleDeadline };
    });
  }

  abandonLease(leaseId: string, now: number): boolean {
    return this.immediate(() => {
      const lease = this.db
        .query<{ cleanup: VpnCleanupPolicy }, [string]>(
          "SELECT cleanup FROM leases WHERE lease_id=?",
        )
        .get(leaseId);
      if (!lease) return false;
      const deleted = this.db.query("DELETE FROM leases WHERE lease_id=?").run(leaseId).changes;
      if (deleted !== 1) return false;
      const remaining =
        this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM leases").get()?.count ??
        0;
      if (lease.cleanup === "leave-running") {
        this.db
          .query(
            `UPDATE vpn_state SET adopt_external_after_start=1,
               evidence='Leave-running adoption retained after guardian generation failure.',
               updated_at=? WHERE singleton=1 AND lifecycle='STARTING'`,
          )
          .run(now);
        this.db
          .query(
            `UPDATE vpn_state SET lifecycle='EXTERNAL', managed_epoch_id=NULL, idle_deadline=NULL,
               operation_id=NULL, operation_kind=NULL, operation_token=NULL, operation_pid=NULL,
               adopt_external_after_start=0, revision=revision+1,
               evidence='Managed VPN adopted after guardian generation failure.', updated_at=?
             WHERE singleton=1 AND lifecycle IN ('ACTIVE','IDLE')`,
          )
          .run(now);
      } else if (remaining === 0) {
        this.db
          .query(
            `UPDATE vpn_state SET lifecycle='UNKNOWN', managed_epoch_id=NULL, idle_deadline=NULL,
               revision=revision+1,
               evidence='VPN guardian generation failed; ownership is ambiguous and no stop is authorized.',
               updated_at=? WHERE singleton=1 AND lifecycle IN ('ACTIVE','IDLE')`,
          )
          .run(now);
      }
      return true;
    });
  }

  deleteDeadLeases(
    isPidLive: (pid: number) => boolean,
    idleDisconnectMs: number,
    now: number,
  ): number {
    return this.immediate(() => {
      const rows = this.db
        .query<{ lease_id: string; owner_pid: number; cleanup: VpnCleanupPolicy }, []>(
          "SELECT lease_id, owner_pid, cleanup FROM leases",
        )
        .all();
      let deleted = 0;
      let adoptExternal = false;
      for (const row of rows) {
        if (!isPidLive(row.owner_pid)) {
          deleted += this.db.query("DELETE FROM leases WHERE lease_id=?").run(row.lease_id).changes;
          adoptExternal ||= row.cleanup === "leave-running";
        }
      }
      const remaining =
        this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM leases").get()?.count ??
        0;
      if (deleted > 0 && adoptExternal) {
        this.db
          .query(
            `UPDATE vpn_state SET adopt_external_after_start=1,
               evidence='Dead leave-running adoption retained during managed VPN start.', updated_at=?
             WHERE singleton=1 AND lifecycle='STARTING'`,
          )
          .run(now);
        this.db
          .query(
            `UPDATE vpn_state SET lifecycle='EXTERNAL', managed_epoch_id=NULL, idle_deadline=NULL,
               operation_id=NULL, operation_kind=NULL, operation_token=NULL, operation_pid=NULL,
               adopt_external_after_start=0, revision=revision+1,
               evidence='Managed VPN adopted after dead leave-running lease reconciliation.', updated_at=?
             WHERE singleton=1 AND lifecycle IN ('ACTIVE','IDLE')`,
          )
          .run(now);
      } else if (deleted > 0 && remaining === 0) {
        this.db
          .query(
            `UPDATE vpn_state SET lifecycle='IDLE', idle_deadline=?, revision=revision+1,
               evidence='Dead stop-if-started lease owner reconciled on next invocation.', updated_at=?
             WHERE singleton=1 AND lifecycle='ACTIVE'`,
          )
          .run(now + idleDisconnectMs, now);
      }
      return deleted;
    });
  }
}
