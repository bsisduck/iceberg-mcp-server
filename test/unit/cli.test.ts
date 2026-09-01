import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli.js';

describe('parseArgs', (): void => {
  it('uses start with no transport override by default', (): void => {
    expect(parseArgs([])).toEqual({ command: 'start', transport: undefined });
  });

  it('parses help, version, and transport options', (): void => {
    expect(parseArgs(['--help'])).toEqual({ command: 'help', transport: undefined });
    expect(parseArgs(['-v'])).toEqual({ command: 'version', transport: undefined });
    expect(parseArgs(['--transport', 'http'])).toEqual({
      command: 'start',
      transport: 'http',
    });
  });

  it('rejects unknown and incomplete options', (): void => {
    expect(() => parseArgs(['--unknown'])).toThrow(/Unknown argument/u);
    expect(() => parseArgs(['--transport'])).toThrow(/must be stdio or http/u);
    expect(() => parseArgs(['--transport', 'tcp'])).toThrow(/must be stdio or http/u);
  });
});
