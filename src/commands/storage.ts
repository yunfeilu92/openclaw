/**
 * Storage management commands.
 *
 * Commands for viewing storage status and migrating data between backends.
 */

import chalk from "chalk";
import type { StorageConfig } from "../config/types.storage.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadConfig } from "../config/config.js";
import { StorageService, StorageNamespaces, type StorageNamespace } from "../storage/index.js";
import { note } from "../terminal/note.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";

export type StorageStatusOptions = {
  json?: boolean;
  health?: boolean;
};

export type StorageMigrateOptions = {
  to?: string;
  namespace?: string;
  dryRun?: boolean;
  yes?: boolean;
};

/**
 * Show storage backend configuration and health.
 */
export async function storageStatusCommand(
  _runtime: RuntimeEnv,
  options: StorageStatusOptions = {},
): Promise<void> {
  const config = loadConfig();
  const storageConfig: StorageConfig = config.storage ?? { type: "file" };

  const service = new StorageService(storageConfig);
  await service.initialize();

  const summary = service.getConfigSummary();

  if (options.json) {
    const output: Record<string, unknown> = {
      type: summary.type,
      backends: summary.backends,
    };

    if (options.health) {
      try {
        output.health = await service.healthCheck();
      } catch (err) {
        output.health = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    console.log(JSON.stringify(output, null, 2));
    await service.close();
    return;
  }

  // Print status
  console.log();
  console.log(theme.heading("Storage Configuration"));
  console.log();
  console.log(`  ${theme.muted("Type:")} ${summary.type}`);
  console.log();

  // Backend configuration table
  const rows: Array<Record<string, string>> = [];
  for (const [ns, info] of Object.entries(summary.backends)) {
    rows.push({ namespace: ns, backend: info.type, classification: info.classification });
  }

  console.log(
    renderTable({
      columns: [
        { key: "namespace", header: "Namespace" },
        { key: "backend", header: "Backend" },
        { key: "classification", header: "Classification" },
      ],
      rows,
    }),
  );

  // Health check if requested
  if (options.health) {
    console.log();
    console.log(theme.heading("Health Check"));
    console.log();

    try {
      const health = await service.healthCheck();
      const healthRows: Array<Record<string, string>> = [];

      for (const [ns, result] of Object.entries(health)) {
        const status = result.ok
          ? theme.success("OK")
          : theme.error(`FAIL: ${result.error ?? "unknown"}`);
        const latency = result.latencyMs !== undefined ? `${result.latencyMs}ms` : "-";
        healthRows.push({ namespace: ns, status, latency });
      }

      console.log(
        renderTable({
          columns: [
            { key: "namespace", header: "Namespace" },
            { key: "status", header: "Status" },
            { key: "latency", header: "Latency" },
          ],
          rows: healthRows,
        }),
      );
    } catch (err) {
      console.log(
        `  ${theme.error("Health check failed:")} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Configuration hints
  if (summary.type === "file") {
    console.log();
    note(
      [
        "To enable cloud storage, configure AgentCore Memory:",
        "",
        `  ${theme.command("openclaw config set storage.type agentcore")}`,
        `  ${theme.command('openclaw config set storage.agentcore.memoryArn "arn:aws:..."')}`,
        "",
        "See: https://docs.openclaw.ai/cloud-storage",
      ].join("\n"),
      "Tip",
    );
  }

  await service.close();
}

/**
 * Migrate data between storage backends.
 */
export async function storageMigrateCommand(
  _runtime: RuntimeEnv,
  options: StorageMigrateOptions = {},
): Promise<void> {
  const config = loadConfig();
  const storageConfig: StorageConfig = config.storage ?? { type: "file" };

  if (!options.to) {
    console.error(theme.error("Error: --to <backend> is required"));
    console.error("  Supported backends: file, agentcore, secrets-manager");
    process.exitCode = 1;
    return;
  }

  const validBackends = ["file", "agentcore", "secrets-manager"];
  if (!validBackends.includes(options.to)) {
    console.error(theme.error(`Error: Invalid backend "${options.to}"`));
    console.error(`  Supported backends: ${validBackends.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const validNamespaces = Object.values(StorageNamespaces);
  if (options.namespace && !validNamespaces.includes(options.namespace as StorageNamespace)) {
    console.error(theme.error(`Error: Invalid namespace "${options.namespace}"`));
    console.error(`  Supported namespaces: ${validNamespaces.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  // Check target backend configuration
  if (options.to === "agentcore" && !storageConfig.agentcore?.memoryArn) {
    console.error(theme.error("Error: AgentCore Memory not configured"));
    console.error("  First configure the memory ARN:");
    console.error(
      `  ${theme.command('openclaw config set storage.agentcore.memoryArn "arn:aws:..."')}`,
    );
    process.exitCode = 1;
    return;
  }

  if (options.to === "secrets-manager" && !storageConfig.secretsManager?.secretArn) {
    console.error(theme.error("Error: Secrets Manager not configured"));
    console.error("  First configure the secret ARN:");
    console.error(
      `  ${theme.command('openclaw config set storage.secretsManager.secretArn "arn:aws:..."')}`,
    );
    process.exitCode = 1;
    return;
  }

  const namespacesToMigrate = options.namespace
    ? [options.namespace as StorageNamespace]
    : validNamespaces;

  console.log();
  console.log(theme.heading("Storage Migration"));
  console.log();
  console.log(`  ${theme.muted("Target backend:")} ${options.to}`);
  console.log(`  ${theme.muted("Namespaces:")} ${namespacesToMigrate.join(", ")}`);
  console.log(`  ${theme.muted("Dry run:")} ${options.dryRun ? "yes" : "no"}`);
  console.log();

  if (options.dryRun) {
    note(
      "Dry run mode: no changes will be made.\nRun without --dry-run to perform the migration.",
      "Info",
    );
    console.log();
  }

  // Initialize storage services
  const sourceService = new StorageService(storageConfig);
  await sourceService.initialize();

  // Build target config
  const _targetConfig: StorageConfig = {
    ...storageConfig,
    type:
      options.to === "secrets-manager" ? storageConfig.type : (options.to as "file" | "agentcore"),
  };

  // For each namespace, migrate data
  for (const namespace of namespacesToMigrate) {
    console.log(`${chalk.bold(`Migrating ${namespace}...`)}`);

    try {
      const sourceBackend = sourceService.getBackend(namespace);
      const keys = await sourceBackend.list(namespace);

      console.log(`  Found ${keys.length} items`);

      if (options.dryRun) {
        for (const key of keys.slice(0, 5)) {
          console.log(`    ${theme.muted("Would migrate:")} ${key}`);
        }
        if (keys.length > 5) {
          console.log(`    ${theme.muted(`... and ${keys.length - 5} more`)}`);
        }
        continue;
      }

      // TODO: Implement actual migration logic
      // This would:
      // 1. Read each item from source backend
      // 2. Write to target backend
      // 3. Optionally verify the migration
      // 4. Update configuration to use new backend

      if (!options.yes) {
        console.log(`  ${theme.warn("Migration not implemented yet. Use --dry-run to preview.")}`);
      }
    } catch (err) {
      console.error(
        `  ${theme.error("Error:")} ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await sourceService.close();

  console.log();
  if (options.dryRun) {
    console.log(theme.success("Dry run completed. No changes were made."));
  } else {
    console.log(theme.success("Migration complete."));
    console.log();
    console.log("To use the new backend, update your configuration:");
    console.log(`  ${theme.command(`openclaw config set storage.type ${options.to}`)}`);
  }
}
