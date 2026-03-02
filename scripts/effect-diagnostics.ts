/**
 * Effect diagnostics using a single shared TypeScript LanguageService.
 *
 * Scans all .ts files that import from "effect" and runs the Effect
 * language service plugin to detect Effect-specific issues.
 *
 * Includes caching — results are reused when source files, tsconfig,
 * and lockfile haven't changed (1 hour TTL).
 */

import effectPlugin from "@effect/language-service";
import { existsSync } from "node:fs";
import ts from "typescript";

const CACHE_DIR = ".effect-cache";
const CACHE_FILE = `${CACHE_DIR}/diagnostics.json`;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export type EffectDiagnostic = {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "message";
  code: number;
};

export type EffectDiagnosticsResult = {
  files: number;
  diagnostics: EffectDiagnostic[];
  totalErrors: number;
  totalWarnings: number;
  totalMessages: number;
  duration: number;
  cacheHit?: boolean;
};

type CacheEntry = {
  hash: string;
  timestamp: number;
  result: EffectDiagnosticsResult;
};

type EffectFile = {
  relativePath: string;
  absolutePath: string;
  content: string;
  contentHash: string;
};

async function loadCache(): Promise<CacheEntry | null> {
  try {
    const cacheFile = Bun.file(CACHE_FILE);
    if (!(await cacheFile.exists())) {
      return null;
    }
    const cache = (await cacheFile.json()) as CacheEntry;
    if (Date.now() - cache.timestamp > CACHE_TTL_MS) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

async function saveCache(hash: string, result: EffectDiagnosticsResult): Promise<void> {
  try {
    const cacheDir = `${process.cwd()}/${CACHE_DIR}`;
    if (!existsSync(cacheDir)) {
      await Bun.spawn(["mkdir", "-p", cacheDir]).exited;
    }
    const entry: CacheEntry = {
      hash,
      timestamp: Date.now(),
      result,
    };
    await Bun.write(CACHE_FILE, JSON.stringify(entry, null, 2));
  } catch {
    // Cache write failures are non-fatal
  }
}

async function findEffectFiles(): Promise<EffectFile[]> {
  const glob = new Bun.Glob("src/**/*.ts");
  const effectFiles: EffectFile[] = [];
  const cwd = process.cwd();

  for await (const file of glob.scan({
    cwd,
    onlyFiles: true,
  })) {
    if (file.includes("node_modules") || file.includes(".test.") || file.includes(".spec.")) {
      continue;
    }

    const absolutePath = `${cwd}/${file}`;
    const content = await Bun.file(absolutePath).text();
    if (content.includes('from "effect"') || content.includes("from 'effect'")) {
      effectFiles.push({
        relativePath: file,
        absolutePath,
        content,
        contentHash: Bun.hash(content).toString(16),
      });
    }
  }

  return effectFiles;
}

function computeCacheHash(files: EffectFile[], tsconfigHash: string, lockfileHash: string): string {
  const contentHashes = (
    files.map((f) => f.contentHash) as string[] & {
      toSorted(compareFn?: (left: string, right: string) => number): string[];
    }
  ).toSorted();
  const combined = [tsconfigHash, lockfileHash, ...contentHashes].join("|");
  return Bun.hash(combined).toString(16);
}

function convertDiagnostic(
  diag: ts.Diagnostic,
  severity: "error" | "warning" | "message",
): EffectDiagnostic | null {
  const file = diag.file;
  if (!file) return null;

  const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");

  // Filter for Effect-specific diagnostics
  if (!message.includes("effect(")) {
    return null;
  }

  const { line, character } = file.getLineAndCharacterOfPosition(diag.start ?? 0);

  return {
    file: file.fileName,
    line: line + 1,
    column: character + 1,
    message,
    severity,
    code: diag.code,
  };
}

export async function runEffectDiagnostics(): Promise<EffectDiagnosticsResult> {
  const totalStart = performance.now();
  const cwd = process.cwd();

  // Step 1: Find all Effect files
  const allEffectFiles = await findEffectFiles();

  if (allEffectFiles.length === 0) {
    return {
      files: 0,
      diagnostics: [],
      totalErrors: 0,
      totalWarnings: 0,
      totalMessages: 0,
      duration: performance.now() - totalStart,
    };
  }

  // Step 2: Check cache
  const tsconfigFile = Bun.file(`${cwd}/tsconfig.json`);
  const tsconfigHash = (await tsconfigFile.exists())
    ? Bun.hash(await tsconfigFile.text()).toString(16)
    : "no-tsconfig";

  const lockfile = Bun.file(`${cwd}/bun.lock`);
  const lockfileHash = (await lockfile.exists())
    ? Bun.hash(await lockfile.text()).toString(16)
    : "no-lockfile";

  const currentHash = computeCacheHash(allEffectFiles, tsconfigHash, lockfileHash);

  const cache = await loadCache();
  if (cache && cache.hash === currentHash) {
    return {
      ...cache.result,
      duration: performance.now() - totalStart,
      cacheHit: true,
    };
  }

  // Step 3: Read tsconfig for compiler options
  const tsconfig = ts.readConfigFile(`${cwd}/tsconfig.json`, (path) => ts.sys.readFile(path));
  const baseOptions = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, cwd).options;

  const compilerOptions: ts.CompilerOptions = {
    ...baseOptions,
    noEmit: true,
    skipLibCheck: true,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
    composite: false,
  };

  // Step 4: Create file map for LanguageServiceHost
  const fileContents = new Map<string, string>();
  const fileNames = allEffectFiles.map((f) => f.absolutePath);

  for (const file of allEffectFiles) {
    fileContents.set(file.absolutePath, file.content);
  }

  // Step 5: Create LanguageServiceHost
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const content = fileContents.get(fileName) ?? ts.sys.readFile(fileName);
      if (content) return ts.ScriptSnapshot.fromString(content);
      return undefined;
    },
    getCurrentDirectory: () => cwd,
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: (path) => ts.sys.fileExists(path),
    readFile: (path) => ts.sys.readFile(path),
    readDirectory: (path, ext, exclude, include, depth) =>
      ts.sys.readDirectory(path, ext, exclude, include, depth),
    directoryExists: (path) => ts.sys.directoryExists(path),
    getDirectories: (path) => ts.sys.getDirectories(path),
  };

  // Step 6: Create LanguageService with Effect plugin
  const documentRegistry = ts.createDocumentRegistry();
  const baseLS = ts.createLanguageService(host, documentRegistry);

  const plugin = effectPlugin({ typescript: ts });
  const languageService = plugin.create({
    languageService: baseLS,
    languageServiceHost: host,
    project: {
      log: () => {
        /* noop - diagnostics run does not need plugin logs */
      },
      getProjectName: () => "effect-check",
    },
    config: { diagnostics: { enabled: true } },
    serverHost: ts.sys,
  } as unknown as ts.server.PluginCreateInfo);

  // Step 7: Get diagnostics for all files
  const diagnostics: EffectDiagnostic[] = [];

  for (const file of allEffectFiles) {
    const semanticDiags = languageService.getSemanticDiagnostics(file.absolutePath);

    for (const diag of semanticDiags) {
      let severity: "error" | "warning" | "message";
      switch (diag.category) {
        case ts.DiagnosticCategory.Error:
          severity = "error";
          break;
        case ts.DiagnosticCategory.Warning:
          severity = "warning";
          break;
        default:
          severity = "message";
      }

      const converted = convertDiagnostic(diag, severity);
      if (converted) {
        diagnostics.push(converted);
      }
    }
  }

  // Step 8: Count by severity
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalMessages = 0;

  for (const diag of diagnostics) {
    switch (diag.severity) {
      case "error":
        totalErrors++;
        break;
      case "warning":
        totalWarnings++;
        break;
      case "message":
        totalMessages++;
        break;
    }
  }

  const result: EffectDiagnosticsResult = {
    files: allEffectFiles.length,
    diagnostics,
    totalErrors,
    totalWarnings,
    totalMessages,
    duration: performance.now() - totalStart,
  };

  // Step 9: Save cache
  await saveCache(currentHash, result);

  return result;
}

export function formatDiagnostics(result: EffectDiagnosticsResult): string {
  const lines: string[] = [];

  for (const diag of result.diagnostics) {
    const severityColor =
      diag.severity === "error"
        ? "\x1b[31m"
        : diag.severity === "warning"
          ? "\x1b[33m"
          : "\x1b[36m";
    const reset = "\x1b[0m";
    lines.push(
      `  ${severityColor}${diag.severity}${reset} [${diag.code}] ${diag.file}:${diag.line}:${diag.column}`,
    );
    lines.push(`    ${diag.message}`);
  }

  return lines.join("\n");
}
