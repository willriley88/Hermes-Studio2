import { describe, expect, it } from 'vitest'
import {
  CHATGPT_MODELS,
  OLLAMA_ENDPOINT,
  buildAnalysisPrompt,
  buildClaudeArgs,
  buildHermesArgs,
  formatOllamaHttpError,
  parseClaudeResult,
  parseHermesResult,
  parseOllamaResult,
  run,
  sanitizeRuntimeEnv,
} from '../server/workbench-runtime'

// Fixtures below are captured verbatim from the real CLIs on this machine.

describe('CLI argument construction', () => {
  /**
   * Regression: `--tools` is VARIADIC. `--tools '' <prompt>` made the CLI treat
   * the prompt as a value of --tools, so it exited 1 with "Input must be
   * provided either through stdin or as a prompt argument". This killed every
   * Claude seat in a crew dispatch while unit tests stayed green.
   */
  it('never passes the Claude prompt as a positional after a variadic flag', () => {
    const { args, stdin } = buildClaudeArgs({ model: 'haiku', prompt: 'ANALYSE THIS', editing: false })
    expect(stdin).toBe('ANALYSE THIS')
    expect(args).not.toContain('ANALYSE THIS')
    const toolsIndex = args.indexOf('--tools')
    if (toolsIndex !== -1) {
      expect(args[toolsIndex + 1]).not.toBe('ANALYSE THIS')
    }
  })

  it('disables Claude tools for analysis but keeps them for edit runs', () => {
    const analyze = buildClaudeArgs({ model: 'haiku', prompt: 'p', editing: false })
    const edit = buildClaudeArgs({ model: 'sonnet', prompt: 'p', editing: true })
    // `--tools ""` is the documented way to disable every built-in tool.
    expect(analyze.args[analyze.args.indexOf('--tools') + 1]).toBe('')
    expect(edit.args).toContain('--permission-mode')
    expect(edit.args).toContain('acceptEdits')
    expect(edit.args).not.toContain('--tools')
  })

  it('pins Hermes analysis runs to a verified empty toolset', () => {
    const analyze = buildHermesArgs({ model: 'gpt-5.6-sol', editing: false })
    expect(analyze[analyze.indexOf('-t') + 1]).toBe('context_engine')
    expect(analyze).toContain('--safe-mode')
    // Prompt always arrives on stdin, never as argv.
    expect(analyze).toContain('--query-file')
    expect(analyze[analyze.indexOf('--query-file') + 1]).toBe('-')
  })

  it('gives Hermes edit runs the real toolset and the worktree', () => {
    const edit = buildHermesArgs({ model: 'gpt-5.6-sol', editing: true, workdir: '/tmp/wt' })
    expect(edit[edit.indexOf('-t') + 1]).toBe('hermes-cli')
    expect(edit[edit.indexOf('--in') + 1]).toBe('/tmp/wt')
    expect(edit).not.toContain('--safe-mode')
  })
})

describe('runtime process input', () => {
  it('rejects instead of crashing when a child closes stdin early', async () => {
    const input = 'x'.repeat(8 * 1024 * 1024)
    await expect(
      run(process.execPath, ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 50)'], {
        input,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/stdin|pipe|epipe/i)
  })
})

describe('runtime model catalog', () => {
  it('does not advertise the ChatGPT-account-incompatible gpt-5.6-codex slug', () => {
    // Captured from the real OAuth endpoint: this slug returns HTTP 400 when
    // used through a ChatGPT subscription, so offering it creates dead seats.
    expect(CHATGPT_MODELS).not.toContain('gpt-5.6-codex')
  })
})

describe('parseHermesResult (openai-codex via Hermes OAuth)', () => {
  const REAL = [
    '{"type": "system", "subtype": "init", "model": "", "session_id": "20260919_210832_48febc"}',
    '{"type": "text", "text": "fmt", "timestamp": 1789866519400}',
    '{"type": "result", "session_id": "20260919_210832_48febc", "exit_code": 0, "text": "fmt_probe_ok", "tokens": {"input": 14103, "output": 7, "total": 14110}}',
  ].join('\n')

  it('extracts the final result text and token usage', () => {
    const parsed = parseHermesResult(REAL)
    expect(parsed.output).toBe('fmt_probe_ok')
    expect(parsed.usage?.total).toBe(14110)
  })

  it('ignores banner noise emitted before the JSONL stream', () => {
    const noisy = '⚠ Deprecated .env settings detected:\n  MESSAGING_CWD=/x found in .env\n' + REAL
    expect(parseHermesResult(noisy).output).toBe('fmt_probe_ok')
  })

  it('treats a non-zero exit_code as a failure rather than an answer', () => {
    const failed =
      '{"type": "result", "exit_code": 1, "text": "partial", "tokens": {"total": 3}}'
    expect(() => parseHermesResult(failed)).toThrow(/exit 1/i)
  })

  it('surfaces WHY the run failed instead of a bare exit code', () => {
    // Captured verbatim: a rate-limited crew seat. "exit code 1" alone sent me
    // hunting a phantom bug; the real cause was sitting in `error`.
    const rateLimited =
      '{"type": "result", "session_id": "s", "exit_code": 1, "text": "ChatGPT or Codex Subscription rate-limited every one of 3 attempts.", "error": "HTTP 429: The usage limit has been reached", "tokens": {"total": 0}}'
    expect(() => parseHermesResult(rateLimited)).toThrow(/429|usage limit/i)
  })

  it('falls back to the result text when there is no explicit error field', () => {
    const failed =
      '{"type": "result", "exit_code": 2, "text": "provider is unreachable", "tokens": {}}'
    expect(() => parseHermesResult(failed)).toThrow(/provider is unreachable/i)
  })

  it('fails loudly when no result event is present', () => {
    expect(() => parseHermesResult('{"type": "text", "text": "hi"}')).toThrow(/no result/i)
  })

  it('fails when the result text is empty', () => {
    expect(() => parseHermesResult('{"type": "result", "exit_code": 0, "text": "   "}')).toThrow(
      /empty/i,
    )
  })
})

describe('parseClaudeResult (Claude CLI, claude.ai subscription)', () => {
  const REAL = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'claude_runtime_ok',
    total_cost_usd: 0.014829,
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 911, outputTokens: 62 } },
    usage: { input_tokens: 10, output_tokens: 51 },
    permission_denials: [],
  })

  it('extracts the result text and the concrete model actually used', () => {
    const parsed = parseClaudeResult(REAL)
    expect(parsed.output).toBe('claude_runtime_ok')
    expect(parsed.actualModel).toBe('claude-haiku-4-5-20251001')
  })

  it('does not report list-price cost as a real charge on a subscription', () => {
    // total_cost_usd is list-price accounting, not money spent on a Claude sub.
    expect(parseClaudeResult(REAL).usage?.costUsd).toBeUndefined()
  })

  it('surfaces is_error responses as failures', () => {
    const errored = JSON.stringify({ is_error: true, result: 'Credit balance too low' })
    expect(() => parseClaudeResult(errored)).toThrow(/credit balance too low/i)
  })

  it('reports permission denials instead of returning a truncated answer', () => {
    const denied = JSON.stringify({
      is_error: false,
      result: 'I need to read a file',
      permission_denials: [{ tool_name: 'Read' }],
    })
    expect(() => parseClaudeResult(denied)).toThrow(/permission/i)
  })

  it('rejects malformed JSON rather than returning raw stdout', () => {
    expect(() => parseClaudeResult('not json at all')).toThrow(/parse/i)
  })
})

describe('parseOllamaResult (local models)', () => {
  it('extracts the response body', () => {
    const real = { model: 'qwen3:4b', response: 'ollama_runtime_ok', done: true }
    expect(parseOllamaResult(real).output).toBe('ollama_runtime_ok')
    expect(parseOllamaResult(real).actualModel).toBe('qwen3:4b')
  })

  it('fails when the model returned nothing', () => {
    expect(() => parseOllamaResult({ response: '', done: true })).toThrow(/empty/i)
  })

  it('surfaces an ollama error payload', () => {
    expect(() => parseOllamaResult({ error: 'model not found' })).toThrow(/model not found/i)
  })

  it('includes the Ollama response body in HTTP errors', () => {
    expect(formatOllamaHttpError(500, '{"error":"model runner crashed"}')).toMatch(
      /model runner crashed/i,
    )
  })
})

describe('billing isolation', () => {
  it('targets only the local Ollama daemon, never Ollama Cloud', () => {
    expect(OLLAMA_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:11434/)
  })

  it('strips paid API keys so no run can silently fall back to per-token billing', () => {
    const env = sanitizeRuntimeEnv({
      PATH: '/usr/bin',
      HOME: '/home/willr',
      ANTHROPIC_API_KEY: 'sk-ant-should-be-removed',
      OPENAI_API_KEY: 'sk-should-be-removed',
      OLLAMA_API_KEY: 'should-be-removed',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/willr')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.OLLAMA_API_KEY).toBeUndefined()
  })
})

describe('buildAnalysisPrompt', () => {
  const prompt = buildAnalysisPrompt({
    rolePrompt: 'You are Nova, a Security Specialist.',
    taskTitle: 'Audit login',
    taskDescription: 'Look for leaked secrets',
    files: [{ path: 'app/login.tsx', content: 'const a = 1\nconst b = 2' }],
  })

  it('includes the role personality, the task, and line-numbered source', () => {
    expect(prompt).toContain('You are Nova, a Security Specialist.')
    expect(prompt).toContain('Audit login')
    expect(prompt).toContain('app/login.tsx')
    expect(prompt).toContain('1 | const a = 1')
    expect(prompt).toContain('2 | const b = 2')
  })

  it('marks the source as untrusted data so embedded instructions are not obeyed', () => {
    expect(prompt.toLowerCase()).toMatch(/untrusted/)
  })

  it('states the run is read-only with no tools', () => {
    expect(prompt.toLowerCase()).toMatch(/read-only/)
  })
})
