import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Run in a killable child: a synchronous eviction-loop regression must never
// block Vitest's event loop (its own timeout cannot interrupt JavaScript).
it.each([-1, -0.5, 0, 0.5, 1])('maxLineages %s returns before SDK send and keeps a bounded map', cap => {
  const script = `
    import assert from 'node:assert/strict';
    import { AnthropicAdapter } from './src/providers/anthropic.ts';
    const a = new AnthropicAdapter({apiKey:'sk-test',cacheKeepalive:{
      suppressOnRefusal:true,lanes:['complete'],maxLineages:${cap}
    }});
    let sends=0;
    const client={messages:{create:async()=>{sends++;return {
      id:'msg',model:'claude-opus-4-1',role:'assistant',type:'message',content:[],
      stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:0}
    };}}};
    client.withOptions=()=>client;a.client=client;
    await a.complete({model:'claude-opus-4-1',maxTokens:1,
      system:[{type:'text',text:'system',cache_control:{type:'ephemeral',ttl:'1h'}}],
      messages:[{role:'user',content:[{type:'text',text:'hi'}]}]});
    assert.equal(sends,1);
    assert.equal(a.cacheKeepalive.outcomes.size,${cap >= 1 ? 1 : 0});
    assert.equal(a.cacheKeepalive.getStatus().length,${cap >= 1 ? 1 : 0});
    a.cacheKeepalive.stop();console.log('returned');
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), timeout: 3000, killSignal: 'SIGKILL', encoding: 'utf8',
  });
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('returned');
}, 10_000);
