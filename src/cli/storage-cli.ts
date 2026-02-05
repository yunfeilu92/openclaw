/**
 * Storage CLI commands.
 *
 * Provides commands for managing cloud storage configuration,
 * viewing storage status, and migrating data between backends.
 */

import type { Command } from "commander";
import {
  storageStatusCommand,
  storageMigrateCommand,
  type StorageStatusOptions,
  type StorageMigrateOptions,
} from "../commands/storage.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerStorageCommands(program: Command) {
  const storage = program
    .command("storage")
    .description("Manage cloud storage backends")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/storage", "docs.openclaw.ai/cli/storage")}\n`,
    );

  storage
    .command("status")
    .description("Show storage backend configuration and health")
    .option("--json", "Output as JSON", false)
    .option("--health", "Include health check results", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await storageStatusCommand(defaultRuntime, {
          json: Boolean(opts.json),
          health: Boolean(opts.health),
        });
      });
    });

  storage
    .command("migrate")
    .description("Migrate data between storage backends")
    .option("--to <backend>", "Target backend: file|agentcore|secrets-manager")
    .option("--namespace <ns>", "Migrate only specific namespace: sessions|transcripts|auth")
    .option("--dry-run", "Show what would be migrated without making changes", false)
    .option("--yes", "Skip confirmation prompts", false)
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await storageMigrateCommand(defaultRuntime, {
          to: opts.to,
          namespace: opts.namespace,
          dryRun: Boolean(opts.dryRun),
          yes: Boolean(opts.yes),
        });
      });
    });
}
