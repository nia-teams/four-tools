/** Public tool surface shared with Nia Teams; the example command is generic. */
export const toolContracts = {
  read: {
    description:
      'Read a file from the workspace. Supports optional line offset and limit for reading specific ranges.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path',
        },
        offset: {
          type: 'integer',
          description: '1-based line number to start reading from',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of lines to read',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  write: {
    description:
      'Write content to a file in the workspace. Creates parent directories if needed. Overwrites existing content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  edit: {
    description:
      'Find and replace a unique string in a file. The old_string must appear exactly once in the file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or workspace-relative file path',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to find (must be unique in the file)',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text',
        },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  shell: {
    description:
      'Execute shell commands or manage persistent terminals in the workspace sandbox.\n\nActions:\n- exec (default): Run a one-shot command, wait for output. For build, test, git, file ops, etc.\n- terminal_create: Create a non-interactive background process. A command is required. When it exits, success or failure is reported back to the originating session by default. Pass notifyOnExit=false only for deliberate fire-and-forget work.\n- terminal_list: List active background processes.\n- terminal_read: Read retained process output (supports offset/limit for incremental reading).\n- terminal_signal: Send signal (SIGINT/SIGTERM/SIGKILL) to a background process.\n- terminal_destroy: Destroy a terminal.\n\nFor exec and terminal_create, when the command is not already self-explanatory, begin it with one short English comment describing the purpose. The comment is valid shell syntax and is shown to the user as the activity title; the remaining lines are executed unchanged. Keep it concrete and non-sensitive.\n\nExample:\n# Inspect the project configuration\ncat package.json',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'exec',
            'terminal_create',
            'terminal_list',
            'terminal_read',
            'terminal_signal',
            'terminal_destroy',
          ],
          description: 'Action to perform (default: exec)',
        },
        command: {
          type: 'string',
          description:
            'Shell command (required for exec / terminal_create). For a non-obvious command, optionally start with a short English `# purpose` comment; it remains valid shell syntax and the UI uses it as the activity title. Example: `# Inspect the project configuration\ncat package.json`. Never put secrets or credentials in the comment.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (exec)',
        },
        timeout: {
          type: 'number',
          minimum: 0,
          description:
            'Timeout in seconds (exec, default 30). No cap — the call returns as soon as the command finishes, so overestimating costs nothing while underestimating costs an extra poll round-trip. Pass your real estimate directly — a build might need 300, a long compute job 1800 or more.',
        },
        id: {
          type: 'string',
          description: 'Terminal ID (read/write/signal/destroy)',
        },
        name: {
          type: 'string',
          description: 'Terminal name (terminal_create)',
        },
        notifyOnExit: {
          type: 'boolean',
          default: true,
          description:
            'Notify and wake the originating session when the terminal command exits (terminal_create, default true). Set false only for deliberate fire-and-forget work.',
        },
        offset: {
          type: 'number',
          description: 'Read start line (terminal_read)',
        },
        limit: {
          type: 'number',
          description: 'Max lines to read (terminal_read)',
        },
        signal: {
          type: 'string',
          enum: ['SIGINT', 'SIGTERM', 'SIGKILL'],
          description: 'Signal (terminal_signal)',
        },
      },
      additionalProperties: false,
    },
  },
} as const;
