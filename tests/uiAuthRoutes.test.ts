import express from 'express';
import { registerRoutes } from '../src/ui/routes';

describe('UI auth routes', () => {
  it('renders auth status and actions without binding a port', async () => {
    const app = express();
    const csrf = 'test-token';
    registerRoutes(app, csrf);
    const layer = (app as any)._router.stack.find((l: any) => l.route && l.route.path === '/auth');
    expect(layer).toBeDefined();
    const handler = layer.route.stack[0].handle;
    let statusCode = 200;
    let body = '';
    const req: any = { method: 'GET', url: '/auth', query: {} };
    const res: any = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      send(payload: any) {
        body = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return this;
      }
    };
    await handler(req, res);
    expect(statusCode).toBe(200);
    expect(body).toContain('E*TRADE');
    expect(body).toContain('csrfToken');
  });
});
