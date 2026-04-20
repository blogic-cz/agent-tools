import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { formatOption, formatOutput } from "#shared";

import {
  envOption,
  formatGrafanaError,
  grafanaFetch,
  profileOption,
  resolveConfig,
} from "./shared";

type DashboardSearchItem = {
  id: number;
  uid: string;
  title: string;
  url: string;
  type: string;
  tags: string[];
  folderTitle?: string;
};

type DashboardDetail = {
  dashboard: {
    id: number;
    uid: string;
    title: string;
    tags: string[];
    version: number;
    panels?: Array<{ id: number; title: string; type: string }>;
  };
};

const listCommand = Command.make(
  "list",
  {
    format: formatOption,
    env: envOption,
    profile: profileOption,
    folder: Flag.optional(
      Flag.string("folder").pipe(Flag.withDescription("Filter by folder title (case-insensitive)")),
    ),
  },
  ({ format, env, profile, folder }) => {
    const start = Date.now();

    return Effect.gen(function* () {
      const config = yield* resolveConfig(env, profile);

      const items = yield* grafanaFetch<DashboardSearchItem[]>(
        config,
        "/api/search?type=dash-db&limit=1000",
      );

      const folderFilter = Option.getOrUndefined(folder)?.toLowerCase();
      const dashboards = items
        .map((item) => ({
          uid: item.uid,
          title: item.title,
          url: item.url,
          tags: item.tags,
          folderTitle: item.folderTitle ?? "General",
        }))
        .filter((item) =>
          folderFilter ? item.folderTitle.toLowerCase().includes(folderFilter) : true,
        );

      const result = {
        success: true,
        message: folderFilter
          ? `Found ${dashboards.length} dashboard(s) in folder '${folderFilter}'`
          : `Found ${dashboards.length} dashboard(s)`,
        data: { dashboards, count: dashboards.length },
        executionTimeMs: Date.now() - start,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: "Failed to list dashboards",
            error: formatGrafanaError(error),
            hint: "Check Grafana is running and accessible",
            executionTimeMs: Date.now() - start,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("List all dashboards"));

const getCommand = Command.make(
  "get",
  { uid: Argument.string("uid"), format: formatOption, env: envOption, profile: profileOption },
  ({ uid, format, env, profile }) => {
    const start = Date.now();

    return Effect.gen(function* () {
      const config = yield* resolveConfig(env, profile);

      const detail = yield* grafanaFetch<DashboardDetail>(
        config,
        `/api/dashboards/uid/${encodeURIComponent(uid)}`,
      );

      const panels = (detail.dashboard.panels ?? []).map((panel) => ({
        id: panel.id,
        title: panel.title,
        type: panel.type,
      }));

      const result = {
        success: true,
        message: `Dashboard: ${detail.dashboard.title}`,
        data: {
          uid: detail.dashboard.uid,
          title: detail.dashboard.title,
          tags: detail.dashboard.tags,
          version: detail.dashboard.version,
          panels,
          panelCount: panels.length,
        },
        executionTimeMs: Date.now() - start,
      };

      yield* Console.log(formatOutput(result, format));
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const result = {
            success: false,
            message: `Failed to get dashboard '${uid}'`,
            error: formatGrafanaError(error),
            hint: "Check the dashboard UID is correct",
            executionTimeMs: Date.now() - start,
          };
          yield* Console.log(formatOutput(result, format));
        }),
      ),
    );
  },
).pipe(Command.withDescription("Get dashboard details by UID"));

export const dashboardsCommand = Command.make("dashboards", {}).pipe(
  Command.withDescription("Dashboard operations"),
  Command.withSubcommands([listCommand, getCommand]),
);
