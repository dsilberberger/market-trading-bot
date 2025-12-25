import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ensureDir, writeJSONFile, readJSONFile } from '../core/utils';

export type ETradeEnv = 'sandbox' | 'prod';

export interface ETradeClientConfig {
  consumerKey: string;
  consumerSecret: string;
  env?: ETradeEnv;
  callbackUrl?: string;
  tokenStorePath?: string;
}

export interface ETradeToken {
  key: string;
  secret: string;
  createdAt: string;
}

export interface ETradeTokenStore {
  requestToken?: ETradeToken;
  accessToken?: ETradeToken;
  oauth_token?: string;
  oauth_token_secret?: string;
  access_token?: string;
  access_token_secret?: string;
  last_verified_at?: string;
  last_api_call_at?: string;
  status?: string;
  status_reason?: string;
}

const defaultStorePath = path.resolve(
  process.cwd(),
  process.env.TOKEN_STORE_PATH ||
    process.env.ETRADE_TOKEN_STORE ||
    `.secrets/etrade_tokens.${(process.env.ETRADE_ENV || 'sandbox').toLowerCase()}.json`
);
const baseApi = (env: ETradeEnv) => (env === 'prod' ? 'https://api.etrade.com' : 'https://apisb.etrade.com');
const authUrl = 'https://us.etrade.com/e/t/etws/authorize';

export class ETradeClient {
  private config: Required<ETradeClientConfig>;
  private oauth: any;
  private storePath: string;
  private encryptionKey?: Buffer;

  constructor(config: ETradeClientConfig) {
    const env = config.env ?? 'sandbox';
    const callbackUrl = config.callbackUrl ?? 'oob';
    const storePath = config.tokenStorePath ?? defaultStorePath;
    this.config = {
      consumerKey: config.consumerKey,
      consumerSecret: config.consumerSecret,
      env,
      callbackUrl,
      tokenStorePath: storePath
    };
    let OAuthLib: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      OAuthLib = require('oauth-1.0a');
    } catch {
      OAuthLib = null;
    }
    if (!OAuthLib) {
      this.oauth = null;
    } else {
      this.oauth = new OAuthLib({
        consumer: { key: this.config.consumerKey, secret: this.config.consumerSecret },
        signature_method: 'HMAC-SHA1',
        hash_function(base_string: string, key: string) {
          return crypto.createHmac('sha1', key).update(base_string).digest('base64');
        }
      });
    }
    this.storePath = storePath;
    const enc = process.env.TOKEN_STORE_ENCRYPTION_KEY;
    if (enc) {
      this.encryptionKey = crypto.createHash('sha256').update(enc).digest();
    }
  }

  private encrypt(data: string): any {
    if (!this.encryptionKey) return data;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: enc.toString('base64')
    };
  }

  private decrypt(payload: any): string {
    if (!this.encryptionKey) {
      if (typeof payload === 'string') return payload;
      throw new Error('Encrypted token store detected but no TOKEN_STORE_ENCRYPTION_KEY set.');
    }
    if (!payload?.iv || !payload?.tag || !payload?.data) {
      throw new Error('Invalid encrypted token store payload');
    }
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const enc = Buffer.from(payload.data, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }

  private loadStore(): ETradeTokenStore {
    if (!fs.existsSync(this.storePath)) return {};
    const raw = readJSONFile<any>(this.storePath);
    if (raw && raw.iv && raw.tag && raw.data) {
      const decrypted = this.decrypt(raw);
      return JSON.parse(decrypted) as ETradeTokenStore;
    }
    if (typeof raw === 'string') {
      return JSON.parse(raw) as ETradeTokenStore;
    }
    return raw as ETradeTokenStore;
  }

  private saveStore(store: ETradeTokenStore) {
    const serialized = JSON.stringify(store);
    if (this.encryptionKey) {
      const payload = this.encrypt(serialized);
      writeJSONFile(this.storePath, payload);
    } else {
      ensureDir(path.dirname(this.storePath));
      writeJSONFile(this.storePath, store);
    }
  }

  public getAuthStatus() {
    const store = this.loadStore();
    return {
      hasAccessToken: Boolean(store.accessToken),
      hasRequestToken: Boolean(store.requestToken),
      accessToken: store.accessToken,
      requestToken: store.requestToken,
      env: this.config.env
    };
  }

  private buildHeader(url: string, method: string, token?: { key: string; secret: string }, data?: Record<string, string>) {
    if (!this.oauth) {
      throw new Error('oauth-1.0a module not available. Install dependency to use E*TRADE.');
    }
    const requestData = { url, method, data };
    const auth = this.oauth.authorize(requestData, token);
    return this.oauth.toHeader(auth);
  }

  public async getRequestToken(): Promise<{ oauthToken: string; oauthTokenSecret: string; authorizeUrl: string }> {
    const url = `${baseApi(this.config.env)}/oauth/request_token`;
    const body = new URLSearchParams({ oauth_callback: this.config.callbackUrl });
    const headers = this.buildHeader(url, 'POST', undefined, { oauth_callback: this.config.callbackUrl });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`E*TRADE request token failed: ${resp.status} ${text}`);
    }
    const params = new URLSearchParams(text);
    const oauthToken = params.get('oauth_token');
    const oauthTokenSecret = params.get('oauth_token_secret');
    if (!oauthToken || !oauthTokenSecret) {
      throw new Error(`E*TRADE request token parse error: ${text}`);
    }
    const store = this.loadStore();
    store.requestToken = { key: oauthToken, secret: oauthTokenSecret, createdAt: new Date().toISOString() };
    ensureDir(path.dirname(this.storePath));
    this.saveStore(store);
    const authorizeUrl = `${authUrl}?key=${encodeURIComponent(this.config.consumerKey)}&token=${encodeURIComponent(
      oauthToken
    )}`;
    return { oauthToken, oauthTokenSecret, authorizeUrl };
  }

  public async exchangeForAccessToken(
    oauthToken: string,
    oauthVerifier: string,
    requestTokenSecretOverride?: string
  ): Promise<ETradeToken> {
    const store = this.loadStore();
    const reqSecret = requestTokenSecretOverride || store.requestToken?.secret || store.oauth_token_secret;
    if (!reqSecret) {
      throw new Error('No request token secret found. Start auth first.');
    }
    const url = `${baseApi(this.config.env)}/oauth/access_token`;
    const body = new URLSearchParams({ oauth_verifier: oauthVerifier });
    const headers = this.buildHeader(url, 'POST', { key: oauthToken, secret: reqSecret }, { oauth_verifier: oauthVerifier });
    const resp = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`E*TRADE access token failed: ${resp.status} ${text}`);
    }
    const params = new URLSearchParams(text);
    const accessToken = params.get('oauth_token');
    const accessSecret = params.get('oauth_token_secret');
    if (!accessToken || !accessSecret) {
      throw new Error(`E*TRADE access token parse error: ${text}`);
    }
    const token: ETradeToken = { key: accessToken, secret: accessSecret, createdAt: new Date().toISOString() };
    store.accessToken = token;
    // mirror into oauth_token fields for compat
    (store as any).oauth_token = accessToken;
    (store as any).oauth_token_secret = accessSecret;
    this.saveStore(store);
    return token;
  }

  public getAccessToken(): ETradeToken | undefined {
    const store = this.loadStore();
    const access = (store as any).accessToken as ETradeToken | undefined;
    if (access?.key && access?.secret) return access;
    const access2 =
      (store as any).access_token && (store as any).access_token_secret
        ? { key: (store as any).access_token, secret: (store as any).access_token_secret, createdAt: new Date().toISOString() }
        : undefined;
    if (access2) return access2;
    if ((store as any).oauth_token && (store as any).oauth_token_secret) {
      return {
        key: (store as any).oauth_token,
        secret: (store as any).oauth_token_secret,
        createdAt: (store as any).accessToken?.createdAt ?? (store as any).requestToken?.createdAt ?? new Date().toISOString()
      };
    }
    return undefined;
  }

  public clearTokens() {
    if (fs.existsSync(this.storePath)) {
      fs.unlinkSync(this.storePath);
    }
  }

  public async signedFetch(
    url: string,
    method: 'GET' | 'POST' = 'GET',
    opts?: { params?: Record<string, string>; body?: string; contentType?: string }
  ): Promise<Response> {
    const token = this.getAccessToken();
    if (!token) {
      throw new Error('E*TRADE access token not available. Complete OAuth first.');
    }
    let targetUrl = url;
    let body: string | URLSearchParams | undefined;
    const params = opts?.params;
    if (method === 'GET' && params) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      targetUrl = u.toString();
    } else if (params) {
      body = new URLSearchParams(params);
    }
    if (opts?.body) {
      body = opts.body;
    }
    const headers = this.buildHeader(targetUrl, method, { key: token.key, secret: token.secret }, params);
    return fetch(targetUrl, {
      method,
      headers: {
        ...headers,
        'Content-Type': opts?.contentType || 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body
    });
  }
}
