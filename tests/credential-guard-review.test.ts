import { expect, it } from "vitest";
import { createCredentialGuard } from "#guard";
const cases = [
  {
    id: "tool-field-0",
    tool: "Read",
    args: {
      file_path: "config/app-secrets.yaml",
    },
    refuse: true,
  },
  {
    id: "tool-field-1",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "config/app-secrets.yaml",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-2",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "config/app-secrets.yaml",
    },
    refuse: true,
  },
  {
    id: "tool-field-3",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "config/app-secrets.yaml",
      output_mode: "files_with_matches",
    },
    refuse: false,
  },
  {
    id: "tool-field-4",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "config/app-secrets.yaml",
      output_mode: "count",
    },
    refuse: false,
  },
  {
    id: "tool-field-5",
    tool: "Read",
    args: {
      file_path: "deploy/db-credentials.txt",
    },
    refuse: true,
  },
  {
    id: "tool-field-6",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "deploy/db-credentials.txt",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-7",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "deploy/db-credentials.txt",
    },
    refuse: true,
  },
  {
    id: "tool-field-8",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "deploy/db-credentials.txt",
      output_mode: "files_with_matches",
    },
    refuse: false,
  },
  {
    id: "tool-field-9",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "deploy/db-credentials.txt",
      output_mode: "count",
    },
    refuse: false,
  },
  {
    id: "tool-field-10",
    tool: "Read",
    args: {
      file_path: "tests/fixtures/credentials.json",
    },
    refuse: true,
  },
  {
    id: "tool-field-11",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "tests/fixtures/credentials.json",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-12",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "tests/fixtures/credentials.json",
    },
    refuse: true,
  },
  {
    id: "tool-field-13",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "tests/fixtures/credentials.json",
      output_mode: "files_with_matches",
    },
    refuse: false,
  },
  {
    id: "tool-field-14",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "tests/fixtures/credentials.json",
      output_mode: "count",
    },
    refuse: false,
  },
  {
    id: "tool-field-15",
    tool: "Read",
    args: {
      file_path: ".env",
    },
    refuse: true,
  },
  {
    id: "tool-field-16",
    tool: "Grep",
    args: {
      pattern: ".",
      path: ".env",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-17",
    tool: "Grep",
    args: {
      pattern: ".",
      path: ".env",
    },
    refuse: true,
  },
  {
    id: "tool-field-18",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "*.{ts,tsx}",
    },
    refuse: false,
  },
  {
    id: "tool-field-19",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "{*.ts,*.tsx}",
    },
    refuse: false,
  },
  {
    id: "tool-field-20",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "src/**/*.{js,ts}",
    },
    refuse: false,
  },
  {
    id: "tool-field-21",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "*.{md,mdx}",
    },
    refuse: false,
  },
  {
    id: "tool-field-22",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "*.ts",
    },
    refuse: false,
  },
  {
    id: "tool-field-23",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "**/*.test.ts",
    },
    refuse: false,
  },
  {
    id: "tool-field-24",
    tool: "Grep",
    args: {
      pattern: "TODO",
      glob: "!*.lock",
    },
    refuse: false,
  },
  {
    id: "tool-field-25",
    tool: "Grep",
    args: {
      pattern: ".",
      glob: "{.env,x}",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-26",
    tool: "Grep",
    args: {
      pattern: ".",
      glob: "*.{env,txt}",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-27",
    tool: "Grep",
    args: {
      pattern: ".",
      glob: "*secret*",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-28",
    tool: "Grep",
    args: {
      pattern: ".",
      glob: "{*.ts,{*.tsx,.env}}",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-29",
    tool: "Grep",
    args: {
      pattern: ".",
      glob: "*.[et][ns][v]",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-30",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "config",
      glob: "*secret*",
      output_mode: "content",
    },
    refuse: true,
  },
  {
    id: "tool-field-31",
    tool: "Grep",
    args: {
      pattern: ".",
      path: "deploy/db-credentials.txt",
      output_mode: "content",
      "-n": true,
    },
    refuse: true,
  },
];
it.each(cases)("checks tool field $id", ({ tool, args, refuse }) => {
  const run = () => createCredentialGuard({}).handleToolExecuteBefore({ tool }, { args });
  if (refuse) expect(run).toThrow(/Access blocked/);
  else expect(run).not.toThrow();
});
