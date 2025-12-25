import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ETradeClient } from '../../integrations/etradeClient';
import { ensureDir } from '../../core/utils';
import { resolveTokenStorePath } from '../../integrations/etradeTokenStore';

export type AuthStatusCode = 'MISSING' | 'NEEDS_CONNECT' | 'ACTIVE' | 'INACTIVE' | 'EXPIRED' | 'ERROR';

export interface AuthStatus {
  status: AuthStatusCode;
  statusReason?: string;
  oauth_token?: string;
  oauth_token_secret?: string;
  access_token?: string;
  access_token_secret?: string;
  last_verified_at?: string;
  last_api_call_at?: string;
  renewable?: boolean;
}

const tokenStorePath = resolveTokenStorePath();
const encryptionKey = process.env.TOKEN_STORE_ENCRYPTION_KEY
  ? crypto.createHash('sha256').update(process.env.TOKEN_STORE_ENCRYPTION_KEY).digest()
  : undefined;

const encryptPayload = (data: string) => {
  if (!encryptionKey) return data;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
};

const decryptPayload = (payload: any): string => {
  if (!encryptionKey) {
    if (typeof payload === 'string') return payload;
    throw new Error('Encrypted token store present but no TOKEN_STORE_ENCRYPTION_KEY set.');
  }
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const enc = Buffer.from(payload.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
};

const loadStore = (): any => {
  if (!fs.existsSync(tokenStorePath)) return {};
  const raw = JSON.parse(fs.readFileSync(tokenStorePath, 'utf-8'));
  if (raw && raw.iv && raw.tag && raw.data) {
    return JSON.parse(decryptPayload(raw));
  }
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
};

const saveStore = (store: any) => {
  ensureDir(path.dirname(tokenStorePath));
  const serialized = JSON.stringify(store);
  if (encryptionKey) {
    fs.writeFileSync(tokenStorePath, JSON.stringify(encryptPayload(serialized), null, 2));
  } else {
    fs.writeFileSync(tokenStorePath, serialized);
  }
};

const buildClient = () => {
  const consumerKey = process.env.ETRADE_CONSUMER_KEY;
  const consumerSecret = process.env.ETRADE_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new Error('ETRADE_CONSUMER_KEY/SECRET missing');
  }
  return new ETradeClient({
    consumerKey,
    consumerSecret,
    env: (process.env.ETRADE_ENV as 'sandbox' | 'prod') || 'sandbox',
    callbackUrl: process.env.ETRADE_CALLBACK_URL,
    tokenStorePath: tokenStorePath
  });
};

export const getStatus = (): AuthStatus => {
  try {
    const store = loadStore();
    const hasAccess = Boolean(store.access_token && store.access_token_secret);
    if (!store.oauth_token && !store.access_token) {
      return { status: 'MISSING', statusReason: 'No tokens present' };
    }
    if (!hasAccess && store.oauth_token) {
      return { status: 'NEEDS_CONNECT', statusReason: 'Request token present, access missing', renewable: false, ...store };
    }
    if (!hasAccess) {
      return { status: 'MISSING', statusReason: 'Access token missing', ...store };
    }
    return { status: 'ACTIVE', renewable: false, ...store };
  } catch (err) {
    return { status: 'ERROR', statusReason: (err as Error).message };
  }
};

export const connectStart = async (): Promise<{ authorizeUrl: string; oauthToken: string }> => {
  const client = buildClient();
  const { authorizeUrl, oauthToken, oauthTokenSecret } = await client.getRequestToken();
  const store = loadStore();
  store.oauth_token = oauthToken;
  store.oauth_token_secret = oauthTokenSecret;
  store.status = 'NEEDS_CONNECT';
  store.statusReason = 'Awaiting verifier';
  saveStore(store);
  return { authorizeUrl, oauthToken };
};

export const connectFinish = async (oauthVerifier: string): Promise<AuthStatus> => {
  const client = buildClient();
  const store = loadStore();
  const oauthToken = store.oauth_token;
  if (!oauthToken || !store.oauth_token_secret) {
    throw new Error('No request token found. Start connect first.');
  }
  const token = await client.exchangeForAccessToken(oauthToken, oauthVerifier, store.oauth_token_secret);
  const next = {
    ...store,
    access_token: token.key,
    access_token_secret: token.secret,
    last_verified_at: new Date().toISOString(),
    status: 'ACTIVE',
    statusReason: 'Access token stored'
  };
  saveStore(next);
  return getStatus();
};

export const renewIfPossible = async (): Promise<{ renewed: boolean; status: AuthStatus }> => {
  // OAuth1 has no silent refresh; require reconnect.
  const status = getStatus();
  return { renewed: false, status: { ...status, statusReason: status.statusReason ?? 'Renew not supported; reconnect required' } };
};

export const withValidAuth = async <T>(fn: () => Promise<T>): Promise<T> => {
  const status = getStatus();
  if (status.status !== 'ACTIVE') {
    throw new Error(`E*TRADE auth not active: ${status.status} ${status.statusReason ?? ''}`);
  }
  return fn();
};

export const preflightAuth = (mode?: string): { status: AuthStatus; allow: boolean; warning?: string } => {
  const status = getStatus();
  if (mode === 'live' && status.status !== 'ACTIVE') {
    return { status, allow: false, warning: 'E*TRADE auth not active; live trading blocked.' };
  }
  if (status.status !== 'ACTIVE') {
    return { status, allow: true, warning: `E*TRADE auth ${status.status}; using stub/paper only.` };
  }
  return { status, allow: true };
};
