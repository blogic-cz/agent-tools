import { aggregateByField, deduplicateLines, formatCountSummary, parseTextTable } from "#shared";

type PodIssueByOwner = {
  owner: string;
  status: string;
  count: number;
  restarts: number;
  pods: string[];
};

type PodIssueIndividual = {
  name: string;
  status: string;
  restarts: number;
};

type PodSummary = {
  summary: string;
  healthy: number;
  issues: Array<PodIssueByOwner | PodIssueIndividual>;
};

type ParsedPod = {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  ready: string;
  owner?: string;
  reason?: string;
};

const HEALTHY_POD_STATUSES = new Set(["Running", "Completed", "Succeeded"]);
const STANDARD_VOLUME_TYPES = ["emptydir", "configmap", "secret"];

function normalizeReplicaSetOwner(ownerName: string): string {
  return ownerName.replace(/-[a-z0-9]{5,10}$/i, "");
}

function getStatusFromContainerState(containerState: unknown): string | undefined {
  if (!containerState || typeof containerState !== "object") {
    return undefined;
  }

  const stateRecord = containerState as Record<string, unknown>;

  const waiting = stateRecord.waiting;
  if (waiting && typeof waiting === "object") {
    const reason = (waiting as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason;
    }
  }

  const terminated = stateRecord.terminated;
  if (terminated && typeof terminated === "object") {
    const reason = (terminated as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason;
    }
  }

  return undefined;
}

function getPodReason(
  status: Record<string, unknown>,
  firstContainer: Record<string, unknown> | undefined,
): string | undefined {
  const containerState = firstContainer?.state;

  if (containerState && typeof containerState === "object") {
    const waiting = (containerState as Record<string, unknown>).waiting;
    if (waiting && typeof waiting === "object") {
      const waitingReason = (waiting as Record<string, unknown>).reason;
      if (typeof waitingReason === "string" && waitingReason.length > 0) {
        return waitingReason;
      }
    }
  }

  const statusReason = status.reason;
  if (typeof statusReason === "string" && statusReason.length > 0) {
    return statusReason;
  }

  return undefined;
}

function parseCpuToMillicores(cpu: string): number {
  const trimmed = cpu.trim();
  if (trimmed.length === 0) return 0;
  if (trimmed.endsWith("m")) {
    const value = Number(trimmed.slice(0, -1));
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  const cores = Number(trimmed);
  if (!Number.isFinite(cores)) return 0;
  return Math.round(cores * 1000);
}

function parseMemoryToMi(memory: string): number {
  const trimmed = memory.trim();
  if (trimmed.length === 0) return 0;

  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)?$/);
  if (!match) return 0;

  const value = Number(match[1]);
  const unit = (match[2] ?? "Mi").toLowerCase();
  if (!Number.isFinite(value)) return 0;

  switch (unit) {
    case "ki":
      return Math.round(value / 1024);
    case "mi":
      return Math.round(value);
    case "gi":
      return Math.round(value * 1024);
    case "ti":
      return Math.round(value * 1024 * 1024);
    case "k":
      return Math.round(value / 1000 / 1024);
    case "m":
      return Math.round(value / 1000 / 1000 / 1024);
    case "g":
      return Math.round(value / 1024);
    default:
      return Math.round(value);
  }
}

function parseKeyValueBlock(lines: string[], initialValue: string): Array<[string, string]> {
  const collected = [initialValue, ...lines]
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "<none>");

  const entries: Array<[string, string]> = [];

  for (const line of collected) {
    const separator = line.includes(":") ? ":" : "=";
    const parts = line.split(separator);
    if (parts.length < 2) continue;

    const key = parts[0]?.trim() ?? "";
    const value = parts.slice(1).join(separator).trim();

    if (key.length > 0) {
      entries.push([key, value]);
    }
  }

  return entries;
}

function parseDescribeSections(
  textOutput: string,
): Map<string, { initial: string; lines: string[] }> {
  const sections = new Map<string, { initial: string; lines: string[] }>();
  const lines = textOutput.split(/\r?\n/);
  const headerPattern = /^([A-Za-z][A-Za-z0-9 _\-()/.]*):\s*(.*)$/;

  let currentSection: string | undefined;

  for (const line of lines) {
    const headerMatch = line.match(headerPattern);
    if (headerMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      const sectionName = headerMatch[1].trim();
      const initial = headerMatch[2] ?? "";
      sections.set(sectionName, { initial, lines: [] });
      currentSection = sectionName;
      continue;
    }

    if (currentSection) {
      const section = sections.get(currentSection);
      if (section) {
        section.lines.push(line);
      }
    }
  }

  return sections;
}

function stripLowValueColumns(rows: Record<string, string>[]): Record<string, string>[] {
  if (rows.length === 0) {
    return rows;
  }

  const keys = Object.keys(rows[0] ?? {});
  const keysToRemove = new Set<string>();

  for (const key of keys) {
    const allNone = rows.every((row) => {
      const value = (row[key] ?? "").trim().toLowerCase();
      return value === "<none>";
    });

    if (allNone) {
      keysToRemove.add(key);
    }
  }

  if (keysToRemove.size === 0) {
    return rows;
  }

  return rows.map((row) => {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!keysToRemove.has(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  });
}

export function transformPods(jsonOutput: string): PodSummary | string {
  try {
    const parsed = JSON.parse(jsonOutput) as { items?: unknown[] };
    if (!Array.isArray(parsed.items)) {
      return jsonOutput;
    }

    const pods: ParsedPod[] = parsed.items.map((item) => {
      const pod = (item ?? {}) as Record<string, unknown>;
      const metadata = (pod.metadata ?? {}) as Record<string, unknown>;
      const status = (pod.status ?? {}) as Record<string, unknown>;
      const containerStatuses = Array.isArray(status.containerStatuses)
        ? (status.containerStatuses as unknown[])
        : [];

      const firstContainer =
        containerStatuses.length > 0 && typeof containerStatuses[0] === "object"
          ? (containerStatuses[0] as Record<string, unknown>)
          : undefined;
      const stateReason = getStatusFromContainerState(firstContainer?.state);

      const restarts = containerStatuses.reduce<number>((sum, entry) => {
        if (!entry || typeof entry !== "object") {
          return sum;
        }
        const restartCount = Number((entry as Record<string, unknown>).restartCount);
        return sum + (Number.isFinite(restartCount) ? restartCount : 0);
      }, 0);

      const readyCount = containerStatuses.reduce<number>((sum, entry) => {
        if (!entry || typeof entry !== "object") {
          return sum;
        }
        return sum + ((entry as Record<string, unknown>).ready === true ? 1 : 0);
      }, 0);

      const ownerReferences = Array.isArray(metadata.ownerReferences)
        ? (metadata.ownerReferences as unknown[])
        : [];
      const ownerRef =
        ownerReferences.length > 0 && typeof ownerReferences[0] === "object"
          ? (ownerReferences[0] as Record<string, unknown>)
          : undefined;
      const ownerNameRaw = typeof ownerRef?.name === "string" ? ownerRef.name : undefined;

      const podReason = getPodReason(status, firstContainer);

      return {
        name: typeof metadata.name === "string" ? metadata.name : "unknown",
        namespace: typeof metadata.namespace === "string" ? metadata.namespace : "default",
        status:
          stateReason ??
          (typeof status.phase === "string" && status.phase.length > 0 ? status.phase : "Unknown"),
        restarts,
        ready: `${readyCount}/${containerStatuses.length}`,
        owner: ownerNameRaw ? normalizeReplicaSetOwner(ownerNameRaw) : undefined,
        reason: podReason,
      };
    });

    const countsByStatus = aggregateByField(pods, "status");
    const summary = formatCountSummary(countsByStatus, pods.length, "pods");
    const healthyPods = pods.filter((pod) => HEALTHY_POD_STATUSES.has(pod.status));
    const issuePods = pods.filter((pod) => !HEALTHY_POD_STATUSES.has(pod.status));

    const groupedIssues = new Map<string, PodIssueByOwner>();
    const individualIssues: PodIssueIndividual[] = [];

    for (const pod of issuePods) {
      if (pod.owner) {
        const key = `${pod.owner}|${pod.status}`;
        const existing = groupedIssues.get(key);

        if (existing) {
          existing.count += 1;
          existing.restarts += pod.restarts;
          existing.pods.push(pod.name);
        } else {
          groupedIssues.set(key, {
            owner: pod.owner,
            status: pod.status,
            count: 1,
            restarts: pod.restarts,
            pods: [pod.name],
          });
        }
      } else {
        individualIssues.push({
          name: pod.name,
          status: pod.status,
          restarts: pod.restarts,
        });
      }
    }

    return {
      summary,
      healthy: healthyPods.length,
      issues: [...groupedIssues.values(), ...individualIssues],
    };
  } catch {
    return jsonOutput;
  }
}

export function transformTop(textOutput: string): Record<string, unknown> {
  const table = parseTextTable(textOutput);
  const rows = table.rows;

  const pods = rows.map((row) => {
    const name = row.NAME ?? row.POD ?? row.PODS ?? "";
    const cpu = row["CPU(cores)"] ?? row.CPU ?? row.CPU_CORES ?? "0m";
    const memory = row["MEMORY(bytes)"] ?? row.MEMORY ?? row.MEMORY_BYTES ?? "0Mi";

    return { name, cpu, memory };
  });

  const totalCpuMillicores = pods.reduce((sum, pod) => sum + parseCpuToMillicores(pod.cpu), 0);
  const totalMemoryMi = pods.reduce((sum, pod) => sum + parseMemoryToMi(pod.memory), 0);

  return {
    summary: `${pods.length} pods: total CPU ${totalCpuMillicores}m, Memory ${totalMemoryMi}Mi`,
    pods,
  };
}

export function transformDescribe(textOutput: string): string {
  const sections = parseDescribeSections(textOutput);
  if (sections.size === 0) {
    return textOutput;
  }

  const outputLines: string[] = [];

  const simpleFields = ["Name", "Namespace", "Status", "Type"];
  for (const field of simpleFields) {
    const section = sections.get(field);
    if (!section) continue;
    const value = section.initial.trim();
    if (value.length > 0) {
      outputLines.push(`${field}: ${value}`);
    }
  }

  const labelsSection = sections.get("Labels");
  if (labelsSection) {
    const labels = parseKeyValueBlock(labelsSection.lines, labelsSection.initial);
    if (labels.length > 0) {
      outputLines.push("Labels:");
      for (const [key, value] of labels) {
        outputLines.push(`  ${key}=${value}`);
      }
    }
  }

  const annotationsSection = sections.get("Annotations");
  if (annotationsSection) {
    const annotations = parseKeyValueBlock(annotationsSection.lines, annotationsSection.initial);
    if (annotations.length > 0) {
      outputLines.push("Annotations:");
      for (const [key, value] of annotations) {
        const compact = value.length > 100 ? `${value.slice(0, 100)}…` : value;
        outputLines.push(`  ${key}: ${compact}`);
      }
    }
  }

  const volumesSection = sections.get("Volumes");
  if (volumesSection) {
    const volumeTypes = volumesSection.lines
      .map((line) => line.trim())
      .filter((line) => line.startsWith("Type:"))
      .map((line) => line.slice("Type:".length).trim().toLowerCase());

    if (volumeTypes.length > 0) {
      const allStandard = volumeTypes.every((type) =>
        STANDARD_VOLUME_TYPES.some((standard) => type.includes(standard)),
      );

      if (allStandard) {
        outputLines.push(
          `Volumes: ${volumeTypes.length} standard volumes (emptyDir/configMap/secret)`,
        );
      }
    }
  }

  const conditionsSection = sections.get("Conditions");
  if (conditionsSection) {
    const conditionLines = conditionsSection.lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^type\s+status/i.test(line));

    const parsedConditions = conditionLines
      .map((line) => line.split(/\s{2,}/).filter((part) => part.length > 0))
      .filter((parts) => parts.length >= 2)
      .map((parts) => ({
        type: parts[0] ?? "",
        status: parts[1] ?? "",
        reason: parts[2] ?? "",
        message: parts.slice(3).join(" "),
      }));

    if (parsedConditions.length > 0) {
      const problematic = parsedConditions.filter((condition) => condition.status !== "True");

      if (problematic.length === 0) {
        outputLines.push(`Conditions: All ${parsedConditions.length} conditions True`);
      } else {
        outputLines.push("Conditions:");
        for (const condition of problematic) {
          const reasonPart = condition.reason.length > 0 ? ` reason=${condition.reason}` : "";
          const messagePart = condition.message.length > 0 ? ` message=${condition.message}` : "";
          outputLines.push(`  ${condition.type}: ${condition.status}${reasonPart}${messagePart}`);
        }
      }
    }
  }

  const eventsSection = sections.get("Events");
  if (eventsSection) {
    const eventLines = eventsSection.lines
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.trimStart().toLowerCase().startsWith("type"));

    if (eventLines.length > 0) {
      outputLines.push("Events:");
      for (const line of eventLines.slice(-10)) {
        outputLines.push(`  ${line.trim()}`);
      }
    }
  }

  return outputLines.join("\n").trim();
}

export function transformLogs(textOutput: string): string {
  return deduplicateLines(textOutput, {
    normalizeTimestamps: true,
    normalizeUUIDs: true,
  });
}

export function transformGenericKubectl(
  textOutput: string,
  _command: string,
): string | Record<string, unknown> {
  const trimmed = textOutput.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return { items: parsed };
      }
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      const ignored = error;
      void ignored;
    }
  }

  const lines = textOutput.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsedTable = parseTextTable(textOutput);
  const looksLikeTable =
    lines.length >= 2 &&
    parsedTable.headers.length >= 2 &&
    parsedTable.rows.length >= 1 &&
    parsedTable.headers.every((header) => /^[A-Z0-9_()\-/]+$/.test(header));

  if (looksLikeTable) {
    const rows = stripLowValueColumns(parsedTable.rows);
    const headers = parsedTable.headers.filter((headerName) =>
      rows.length === 0 ? true : rows.some((row) => headerName in row),
    );
    return { headers, rows };
  }

  if (lines.length > 50) {
    return deduplicateLines(textOutput);
  }

  return textOutput;
}
