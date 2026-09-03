import { describe, it, expect } from 'vitest';
import { buildCollectRecipe, registerHowToCollect } from '../src/tools/how-to-collect.js';
import { createToolHandlerStub } from './helpers/tool-stub.js';

describe('how_to_collect recipe', () => {
  it('builds the next-server recipe with a standalone fallback', () => {
    const recipe = buildCollectRecipe('next-server');
    expect(recipe.scenario).toBe('next-server');
    expect(recipe.command).toBe(
      'node --cpu-prof --cpu-prof-dir=./.perf-profiles ./node_modules/next/dist/bin/next start',
    );
    expect(recipe.outputDir).toBe('./.perf-profiles');
    expect(recipe.steps.some((step) => step.includes('standalone'))).toBe(true);
    expect(recipe.steps.some((step) => step.includes('.next/standalone/server.js'))).toBe(true);
  });

  it('uses .next/standalone/server.js as the script example', () => {
    const recipe = buildCollectRecipe('script');
    expect(recipe.scenario).toBe('script');
    expect(recipe.command).toBe(
      'node --cpu-prof --cpu-prof-dir=./.perf-profiles .next/standalone/server.js',
    );
  });

  it('always includes a nextStep pointing at load_profile', () => {
    for (const scenario of ['next-server', 'script'] as const) {
      const recipe = buildCollectRecipe(scenario);
      expect(recipe.nextStep).toContain('load_profile');
      expect(recipe.nextStep).toContain('.perf-profiles');
    }
  });

  it('lists ordered steps ending in a load_profile call', () => {
    const recipe = buildCollectRecipe('next-server');
    expect(recipe.steps.length).toBeGreaterThan(1);
    expect(recipe.steps[recipe.steps.length - 1]).toContain('load_profile');
  });
});

describe('how_to_collect tool – default scenario', () => {
  it('defaults to the next-server recipe when scenario is omitted', async () => {
    const { server, call } = createToolHandlerStub();
    registerHowToCollect(server);

    const result = await call('how_to_collect', {});
    const payload = JSON.parse(result.content[0].text as string);

    expect(payload.scenario).toBe('next-server');
    expect(payload.command).toBe(
      'node --cpu-prof --cpu-prof-dir=./.perf-profiles ./node_modules/next/dist/bin/next start',
    );
  });
});
