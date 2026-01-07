import fs from 'fs';
import path from 'path';

describe('small brokerage universe config', () => {
  const cfgPath = path.resolve(__dirname, '../src/config/default.small.json');
  const universePath = path.resolve(__dirname, '../src/config/universe_small.json');
  const exposurePath = path.resolve(__dirname, '../src/config/exposure_groups_small.json');
  const proxiesPath = path.resolve(__dirname, '../src/config/proxies_small.json');

  it('matches expected ticker list', () => {
    const expected = ['VTI', 'VXUS', 'VTV', 'USMV', 'SHY', 'IEF', 'TIP'];
    const universe = JSON.parse(fs.readFileSync(universePath, 'utf-8')) as string[];
    expect(universe).toEqual(expected);
  });

  it('has exposure metadata entries for each ticker', () => {
    const universe = JSON.parse(fs.readFileSync(universePath, 'utf-8')) as string[];
    const exposures = JSON.parse(fs.readFileSync(exposurePath, 'utf-8')) as Record<string, { members: string[] }>;
    const members = Object.values(exposures).flatMap((g) => g.members);
    universe.forEach((sym) => {
      expect(members).toContain(sym);
    });
  });

  it('config points to small-universe files', () => {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as any;
    expect(cfg.universeFile).toBe('src/config/universe_small.json');
    expect(cfg.exposureGroupsFile).toBe('src/config/exposure_groups_small.json');
    expect(cfg.proxiesFile).toBe('src/config/proxies_small.json');
  });

  it('proxies include execution fallbacks for mapped tickers', () => {
    const proxies = JSON.parse(fs.readFileSync(proxiesPath, 'utf-8')) as Record<string, string[]>;
    expect(proxies.VTI).toEqual(['ITOT', 'SCHB']);
    expect(proxies.VXUS).toEqual(['IXUS']);
    expect(proxies.VTV).toEqual(['SCHV', 'IWD']);
    expect(proxies.SHY).toEqual(['VGSH', 'SCHO', 'SHV']);
    expect(proxies.IEF).toEqual(['SCHR', 'VGIT']);
    expect(proxies.TIP).toEqual(['SCHP', 'VTIP']);
  });
});
