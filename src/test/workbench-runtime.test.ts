import { describe, expect, it } from 'vitest'
import {
  OLLAMA_ENDPOINT,
  buildAnalysisPrompt,
  parseClaudeResult,
  parseHermesResult,
  parseOllamaResult,
  sanitizeRuntimeEnv,
} from '../server/workbench-runtime'

// Fixtures below are captured verbatim from the real CLIs on this machine.

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
    expect(() => parseHermesResult(failed)).toThrow(/exit code 1/i)
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
