#!/usr/bin/env node
import { pickTweet } from '../src/pick.js';
import { quotePost } from '../src/quote-post.js';
import { sproutReport } from '../src/sprout-report.js';

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h') {
    return { command: 'help', options: { help: true } };
  }
  const command = args.shift() || 'pick';
  const options = {};

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--session') {
      options.session = args.shift();
    } else if (arg === '--url') {
      options.url = args.shift();
    } else if (arg === '--opencli-bin') {
      options.opencli = { ...(options.opencli || {}), bin: args.shift() };
    } else if (arg === '--getnote-bin') {
      options.getnote = { ...(options.getnote || {}), bin: args.shift() };
    } else if (arg === '--state-dir') {
      options.stateDir = args.shift();
    } else if (arg === '--cwd') {
      options.cwd = args.shift();
    } else if (arg === '--max-scrolls') {
      options.maxScrolls = Number(args.shift());
    } else if (arg === '--pre-x-jitter-min') {
      args.shift();
    } else if (arg === '--pre-x-jitter-max') {
      args.shift();
    } else if (arg === '--dry-run-input') {
      options.dryRunInput = true;
    } else if (arg === '--dev-create-task') {
      options.devCreateTask = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      const error = new Error(`Unknown argument: ${arg}`);
      error.code = 'ARGUMENT_ERROR';
      throw error;
    }
  }

  return { command, options };
}

function help() {
  return `Usage:
  x-radar pick [--session <name>] [--url <x-list-url>] [--opencli-bin <path>] [--state-dir <dir>] [--cwd <dir>] [--max-scrolls <n>]
  x-radar sprout-report [--session <name>] [--opencli-bin <path>] [--getnote-bin <path>] [--state-dir <dir>] [--cwd <dir>] [--dev-create-task]
  x-radar quote-post [--session <name>] [--opencli-bin <path>] [--state-dir <dir>] [--cwd <dir>] [--dry-run-input]

Default command:
  x-radar pick

State directory:
  --state-dir wins, --cwd is a legacy alias, then X_RADAR_STATE_DIR, then the current directory.
`;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  if (command === 'help') {
    process.stdout.write(help());
    return;
  }
  if (command === 'pick') {
    const result = await pickTweet(options);
    print(result);
    return;
  }
  if (command === 'sprout-report') {
    const result = await sproutReport(options);
    print(result);
    return;
  }
  if (command === 'quote-post') {
    const result = await quotePost(options);
    print(result);
    return;
  }
  {
    const error = new Error(`Unknown command: ${command}`);
    error.code = 'ARGUMENT_ERROR';
    throw error;
  }
}

main().catch((error) => {
  print({
    ok: false,
    error: {
      code: error.code || 'X_RADAR_FAILED',
      message: error.message,
    },
  });
  process.exitCode = error.exitCode || 1;
});
