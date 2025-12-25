import fs from 'fs';
import os from 'os';
import path from 'path';

describe('authService status transitions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  const tokenPath = path.join(tmp, 'tokens.json');
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.TOKEN_STORE_PATH = tokenPath;
    delete process.env.TOKEN_STORE_ENCRYPTION_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('walks through missing -> needs connect -> active -> renew', async () => {
    await new Promise<void>((resolve) => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const service = require('../src/broker/etrade/authService');
        fs.writeFileSync(tokenPath, JSON.stringify({}));
        expect(service.getStatus().status).toBe('MISSING');
        fs.writeFileSync(tokenPath, JSON.stringify({ oauth_token: 'req', oauth_token_secret: 'secret' }));
        expect(service.getStatus().status).toBe('NEEDS_CONNECT');
        fs.writeFileSync(
          tokenPath,
          JSON.stringify({
            oauth_token: 'req',
            oauth_token_secret: 'secret',
            access_token: 'acc',
            access_token_secret: 'asec'
          })
        );
        expect(service.getStatus().status).toBe('ACTIVE');
        service.renewIfPossible().then((renewed: any) => {
          expect(renewed.renewed).toBe(false);
          expect(renewed.status.statusReason).toContain('Renew');
          resolve();
        });
      });
    });
  });
});
