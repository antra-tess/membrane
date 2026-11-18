import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';

const startupMs = 60_000;
const defaultExecutionMs = 30_000;
const stuckExecutionMs = 50;
const slowStartupMs = 5_100;
const selfTestExecutionMs = 1_000;
const selfTestTimeoutMs = 180_000;

function runChild(script: string, executionMs = defaultExecutionMs) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; signal: string | null; executionElapsedMs: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('../../', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', ready = false;
    let readyAt: number | undefined;
    // Import/startup has its own generous watchdog. The bounded-loop deadline
    // starts only after the child confirms that its imports have completed.
    let timer = setTimeout(() => child.kill('SIGKILL'), startupMs);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (!ready && stdout.includes('ready\n')) {
        ready = true;
        readyAt = performance.now();
        clearTimeout(timer);
        timer = setTimeout(() => child.kill('SIGKILL'), executionMs);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, stdout, stderr, signal,
      executionElapsedMs: readyAt === undefined ? Infinity : performance.now() - readyAt }); });
  });
}

// Run in a killable child: a synchronous eviction-loop regression must never
// block Vitest's event loop (its own timeout cannot interrupt JavaScript).
it.each([-1, -0.5, 0, 0.5, 1])('maxLineages %s returns before SDK send and keeps a bounded map', async cap => {
  const script = `
    import assert from 'node:assert/strict';
    import { AnthropicAdapter } from './src/providers/anthropic.ts';
    console.log('ready');
    const a = new AnthropicAdapter({apiKey:'sk-test',cacheKeepalive:{
      suppressOnRefusal:true,lanes:['complete'],maxLineages:${cap}
    }});
    let sends=0;
    const client={messages:{create:async()=>{sends++;return {
      id:'msg',model:'claude-opus-4-1',role:'assistant',type:'message',content:[],
      stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:0}
    };}}};
    client.withOptions=()=>client;a.client=client;
    for (const system of ['first', 'second']) await a.complete({model:'claude-opus-4-1',maxTokens:1,
      system:[{type:'text',text:system,cache_control:{type:'ephemeral',ttl:'1h'}}],
      messages:[{role:'user',content:[{type:'text',text:'hi'}]}]});
    assert.equal(sends,2);
    assert.equal(a.cacheKeepalive.outcomes.size,${cap >= 1 ? 1 : 0});
    assert.equal(a.cacheKeepalive.getStatus().length,${cap >= 1 ? 1 : 0});
    a.cacheKeepalive.stop();console.log('returned');
  `;
  const result = await runChild(script);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('ready\n');
  expect(result.stdout).toContain('returned');
}, 100_000);


it('bounded-loop watchdog excludes child startup but still kills a stuck loop', async () => {
  const slowStart = await runChild(`
    await new Promise(resolve => setTimeout(resolve, ${slowStartupMs}));
    console.log('ready');
    console.log('returned');
  `, selfTestExecutionMs);
  expect(slowStart.code, slowStart.stderr).toBe(0);
  expect(slowStart.stdout).toContain('returned');
  const stuck = await runChild(`console.log('ready'); while (true) {}`, stuckExecutionMs);
  expect(stuck.code).toBeNull();
  expect(stuck.signal).toBe('SIGKILL');
  expect(stuck.stdout).toContain('ready');
  // Generous scheduling slack, but not the separate 60-second startup deadline.
  expect(stuck.executionElapsedMs).toBeLessThan(5_000);
}, selfTestTimeoutMs);

for (const suppression of ['{}', '{suppressOnRefusal:false}']) {
  it.each(['-Infinity', '-1', '-0.5'])(`default-off negative cap %s is killably bounded (${suppression})`, async cap => {
    const result = await runChild(`
      import assert from 'node:assert/strict';
      import { CacheKeepalive } from './src/cache-keepalive.ts';
      console.log('ready');
      let sends = 0;
      const k = new CacheKeepalive(async () => { sends++; return {}; }, {
        ...${suppression}, maxLineages:${cap}, refreshAfterMs:0
      });
      for (let i=0;i<8;i++) k.record({model:String(i), system:[{
        type:'text',text:'system',cache_control:{type:'ephemeral',ttl:'1h'}
      }],messages:[]}, undefined, 'stream');
      assert.equal(k.getStatus().length,0);
      await k.tick();
      assert.equal(sends,0);
      k.stop();console.log('returned');
    `);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('returned');
  }, 100_000);
}

it('watchdog self-test budget covers both sequential startup and execution bounds plus close slack', () => {
  expect(slowStartupMs).toBeGreaterThan(selfTestExecutionMs);
  expect(selfTestTimeoutMs).toBeGreaterThan(2 * startupMs + defaultExecutionMs + stuckExecutionMs + 10_000);
});
