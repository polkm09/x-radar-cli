import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const pythonSnippet = `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("pipeline", "x_radar_pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

seen = []

class Result:
    returncode = 0
    stdout = "ok"
    stderr = ""

def fake_run(args, capture_output, text, encoding, timeout):
    seen.append(timeout)
    return Result()

pipeline.subprocess.run = fake_run
pipeline.run_cmd(["getnote"], timeout=0)
pipeline.run_cmd(["getnote"], timeout=45)
print(json.dumps(seen))
`;

describe('pipeline command timeout handling', () => {
  it('treats getnote timeout 0 as no subprocess timeout while preserving positive timeouts', () => {
    const result = spawnSync('python3', ['-c', pythonSnippet], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([null, 45]);
  });
});
