import { BotConfig, Fill, OrderPlacement, OrderPreview, PortfolioState, TradeOrder } from '../../core/types';
import { MarketDataProvider } from '../../data/marketData.types';
import { Broker } from '../broker.types';
import { ETradeClient } from '../../integrations/etradeClient';
import { StubBroker } from '../broker.stub';

const baseApi = (env: string) => (env === 'prod' ? 'https://api.etrade.com' : 'https://apisb.etrade.com');
const ORDER_STATUS_URL = (env: string, accountKey: string, orderId: string | number) =>
  `${baseApi(env)}/v1/accounts/${accountKey}/orders/${orderId}.json`;

const extractExecutions = (payload: any, asOf?: string) => {
  const fills: {
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price: number;
    time?: string;
  }[] = [];

  const orderDetails =
    payload?.OrderResponse?.OrderDetail ||
    payload?.OrderResponse?.orderDetail ||
    payload?.OrdersResponse?.OrderDetail ||
    payload?.OrdersResponse?.orderDetail ||
    [];

  const detailsArray = Array.isArray(orderDetails) ? orderDetails : [orderDetails];

  for (const detail of detailsArray) {
    const instruments = detail?.Instrument || detail?.instrument || [];
    const instArray = Array.isArray(instruments) ? instruments : [instruments];
    for (const inst of instArray) {
      const execs = inst?.Execution || inst?.execution || [];
      const execArray = Array.isArray(execs) ? execs : [execs];
      for (const ex of execArray) {
        const qty = Number(ex?.quantity || ex?.filledQuantity || 0);
        const price = Number(ex?.price || ex?.filledPrice || 0);
        if (!qty || !inst?.Product?.symbol) continue;
        const timeRaw = ex?.time ?? ex?.timestamp ?? ex?.executionTime;
        let timeIso: string | undefined;
        if (timeRaw !== undefined && timeRaw !== null) {
          const n = Number(timeRaw);
          const d = Number.isNaN(n) ? new Date(timeRaw) : new Date(n);
          if (!Number.isNaN(d.getTime())) {
            timeIso = d.toISOString();
          }
        }
        if (!timeIso && asOf) {
          const d = new Date(asOf);
          if (!Number.isNaN(d.getTime())) timeIso = d.toISOString();
        }
        fills.push({
          symbol: inst.Product.symbol,
          side: inst?.orderAction === 'SELL' ? 'SELL' : 'BUY',
          quantity: qty,
          price,
          time: timeIso
        });
      }
    }
  }
  return fills;
};

interface ETradeAccount {
  accountIdKey: string;
}

export class ETradeBroker implements Broker {
  private delegate: StubBroker;
  private client: ETradeClient;
  private env: string;
  private accountIdKey?: string;
  private marketData: MarketDataProvider;
  private config: BotConfig;
  private hardFail: boolean;

  constructor(config: BotConfig, marketData: MarketDataProvider, client: ETradeClient) {
    this.delegate = new StubBroker(config, marketData);
    this.client = client;
    this.env = (process.env.ETRADE_ENV as string) || 'sandbox';
    this.marketData = marketData;
    this.config = config;
    // If we're using the E*TRADE broker/provider in live context, do not silently fall back to stub.
    const providerIsEtrade = (process.env.BROKER_PROVIDER || 'stub').toLowerCase() === 'etrade';
    this.hardFail = providerIsEtrade || process.env.USE_ETRADE_ORDERS === 'true';
  }

  private async getAccountIdKey(): Promise<string | undefined> {
    if (this.accountIdKey) return this.accountIdKey;
    try {
      const resp = await this.client.signedFetch(`${baseApi(this.env)}/v1/accounts/list.json`, 'GET');
      const text = await resp.text();
      if (!resp.ok) throw new Error(`accounts/list ${resp.status}: ${text.slice(0, 200)}`);
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch (err) {
        throw new Error(`accounts list parse error: ${text.slice(0, 200)}`);
      }
      const accounts: any[] = json?.AccountListResponse?.Accounts?.Account || [];
      const override = process.env.ETRADE_ACCOUNT_ID_KEY;
      const activeBrokerage = accounts.filter(
        (a) => a?.accountStatus === 'ACTIVE' && String(a?.institutionType || '').toUpperCase().includes('BROKERAGE')
      );
      if (override && activeBrokerage.some((a) => a.accountIdKey === override)) {
        this.accountIdKey = override;
        return override;
      }
      // Prefer self-directed / non-managed accounts
      const pick = activeBrokerage.find(
        (a) =>
          typeof a.accountDesc === 'string' &&
          !/robo/i.test(a.accountDesc) &&
          !/managed/i.test(a.accountDesc)
      );
      const id = pick?.accountIdKey || activeBrokerage[0]?.accountIdKey;
      if (id) this.accountIdKey = id;
      else throw new Error('No active brokerage account found');
      return id;
    } catch (err) {
      console.warn(`E*TRADE getAccountIdKey failed: ${(err as Error).message}`);
      if (this.hardFail) throw err;
      return undefined;
    }
  }

  private async getBalanceCash(accountKey: string): Promise<number> {
    const url = `${baseApi(this.env)}/v1/accounts/${accountKey}/balance.json?instType=BROKERAGE`;
    const resp = await this.client.signedFetch(url, 'GET');
    const text = await resp.text();
    if (!resp.ok) throw new Error(`balance ${resp.status}: ${text.slice(0, 200)}`);
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error(`balance parse error: ${text.slice(0, 200)}`);
    }
    const cash =
      Number(json?.BalanceResponse?.Computed?.cashBalance) ||
      Number(json?.BalanceResponse?.Computed?.cashAvailableForInvestment) ||
      0;
    const buyingPower =
      Number(json?.BalanceResponse?.Computed?.cashBuyingPower) ||
      Number(json?.BalanceResponse?.Computed?.purchasingPower) ||
      Number(json?.BalanceResponse?.Computed?.marginBuyingPower) ||
      0;
    return cash > 0 ? cash : buyingPower;
  }

  async getPortfolioState(asOf: string): Promise<PortfolioState> {
    const accountKey = await this.getAccountIdKey();
    if (!accountKey) return this.delegate.getPortfolioState(asOf);
    try {
      const resp = await this.client.signedFetch(
        `${baseApi(this.env)}/v1/accounts/${accountKey}/portfolio.json?count=50&totals=true`,
        'GET'
      );
      const text = await resp.text();
      if (resp.status === 204) {
        // No positions returned; fetch balance for cash only
        const cash = await this.getBalanceCash(accountKey);
        return { cash, holdings: [], equity: cash };
      }
      if (!resp.ok) throw new Error(`portfolio ${resp.status}: ${text.slice(0, 200)}`);
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch (err) {
        throw new Error(`portfolio parse error: ${text.slice(0, 200)}`);
      }
      const positions = json?.PortfolioResponse?.AccountPortfolio?.[0]?.Position ?? [];
      const holdings: PortfolioState['holdings'] = [];
      let equity = 0;
      for (const p of positions) {
        const qty = Number(p?.quantity);
        const sym = p?.Product?.symbol;
        if (!sym || Number.isNaN(qty) || qty <= 0) continue;
        const avg = Number(p?.pricePaid ?? 0);
        let mark = avg;
        try {
          const q = await this.marketData.getQuote(sym, asOf);
          mark = q.price;
        } catch {
          mark = avg;
        }
        holdings.push({
          symbol: sym,
          quantity: qty,
          avgPrice: avg,
          holdSince: undefined
        });
        equity += qty * mark;
      }
      const balance = json?.PortfolioResponse?.AccountPortfolio?.[0]?.AccountBalance;
      const cash = Number(balance?.cashBalance ?? balance?.cashAvailableForWithdrawal ?? 0);
      equity += cash;
      return { cash, holdings, equity };
    } catch (err) {
      console.warn(`E*TRADE portfolio fallback to stub: ${(err as Error).message}`);
      if (this.hardFail) throw err;
      return this.delegate.getPortfolioState(asOf);
    }
  }

  async previewOrder(order: TradeOrder, asOf: string): Promise<OrderPreview> {
    const stubPreview = await this.delegate.previewOrder(order, asOf);
    const accountKey = await this.getAccountIdKey();
    if (!accountKey) return stubPreview;

    const quote = await this.marketData.getQuote(order.symbol, asOf);

    const attemptPreview = async (): Promise<{ previewId?: string | number; quantity: number }> => {
      const qtyNumber = Math.floor((order.notionalUSD ?? 0) / Math.max(1e-6, quote.price || 1));
      if (qtyNumber < 1) {
        throw new Error(`Notional ${order.notionalUSD} too small for whole-share order at price ${quote.price}`);
      }
      const qtyString = String(qtyNumber);

      // Match official E*TRADE sample structure: Order[], Instrument[] with capitalized keys and strings.
      const body = {
        PreviewOrderRequest: {
          orderType: 'EQ',
          clientOrderId: `bot${Date.now().toString().slice(-8)}`,
          Order: [
            {
              allOrNone: 'false',
              priceType: 'MARKET',
              orderTerm: 'GOOD_FOR_DAY',
              marketSession: 'REGULAR',
              stopPrice: '',
              limitPrice: '',
              Instrument: [
                {
                  Product: { securityType: 'EQ', symbol: order.symbol },
                  orderAction: order.side.toUpperCase(),
                  quantity: qtyString
                }
              ]
            }
          ]
        }
      };
      const url = `${baseApi(this.env)}/v1/accounts/${accountKey}/orders/preview.json`;
      const resp = await this.client.signedFetch(url, 'POST', {
        body: JSON.stringify(body),
        contentType: 'application/json'
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`preview failed ${resp.status}: ${text.slice(0, 400)}`);
      const parsed = JSON.parse(text);
      const previewId =
        parsed?.PreviewOrderResponse?.previewId ??
        parsed?.PreviewOrderResponse?.PreviewIds?.[0]?.previewId ??
        parsed?.PreviewOrderResponse?.previewIds?.[0]?.previewId;
      return { previewId, quantity: qtyNumber };
    };

    try {
      const primary = await attemptPreview();
      return {
        ...stubPreview,
        previewId: primary.previewId,
        quantity: primary.quantity,
        quantityType: 'QUANTITY'
      };
    } catch (err) {
      console.warn(`E*TRADE preview failed: ${(err as Error).message}`);
      if (this.hardFail) throw err;
    }
    return stubPreview;
  }

  private async previewViaApi(order: TradeOrder, accountKey: string, qtyValue: number) {
    const qtyString = String(qtyValue);
    const body = {
      PreviewOrderRequest: {
        orderType: 'EQ',
        clientOrderId: `bot${Date.now().toString().slice(-8)}`,
        Order: [
          {
            allOrNone: 'false',
            priceType: 'MARKET',
            orderTerm: 'GOOD_FOR_DAY',
            marketSession: 'REGULAR',
            stopPrice: '',
            limitPrice: '',
            Instrument: [
              {
                Product: { securityType: 'EQ', symbol: order.symbol },
                orderAction: order.side.toUpperCase(),
                quantity: qtyString
              }
            ]
          }
        ]
      }
    };
    const url = `${baseApi(this.env)}/v1/accounts/${accountKey}/orders/preview.json`;
    const resp = await this.client.signedFetch(url, 'POST', { body: JSON.stringify(body), contentType: 'application/json' });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`preview failed ${resp.status}: ${text.slice(0, 400)}`);
    const parsed = JSON.parse(text);
    const previewId =
      parsed?.PreviewOrderResponse?.previewId ??
      parsed?.PreviewOrderResponse?.PreviewIds?.[0]?.previewId ??
      parsed?.PreviewOrderResponse?.previewIds?.[0]?.previewId;
    return { previewId, raw: parsed };
  }

  async placeOrder(order: TradeOrder, asOf: string): Promise<OrderPlacement> {
    const accountKey = await this.getAccountIdKey();
    if (!accountKey) return this.delegate.placeOrder(order, asOf);
    try {
      const preview = await this.previewOrder(order, asOf);
      const quantityType = 'QUANTITY';
      const impliedPrice =
        preview.quantity > 0 ? preview.estimatedCost / preview.quantity : Math.max(1, order.notionalUSD || 1);
      let qtyValue = Math.floor((order.notionalUSD ?? preview.estimatedCost) / Math.max(1e-6, impliedPrice));
      // Guard against floating-point rounding pulling qtyValue below 1 when notional ~= price
      if (
        qtyValue < 1 &&
        order.notionalUSD !== undefined &&
        impliedPrice > 0 &&
        order.notionalUSD + 1e-6 >= impliedPrice
      ) {
        qtyValue = 1;
      }
      if (qtyValue < 1) {
        throw new Error(`Notional ${order.notionalUSD} too small for whole-share order (px ~${impliedPrice})`);
      }
      let previewId: string | number | undefined = preview.previewId;
      if (!previewId) {
        try {
          const p = await this.previewViaApi(order, accountKey, qtyValue);
          previewId = p.previewId;
        } catch (err) {
          console.warn(`E*TRADE preview fallback to stub: ${(err as Error).message}`);
        }
      }
      if (process.env.USE_ETRADE_ORDERS === 'true') {
        const attemptPlace = async (qty: number) => {
          if (!previewId) {
            const freshPreview = await this.previewViaApi(order, accountKey, qty);
            previewId = freshPreview.previewId;
          }
          if (!previewId) throw new Error('No previewId returned from E*TRADE preview; cannot place live order.');
          const url = `${baseApi(this.env)}/v1/accounts/${accountKey}/orders/place.json`;
          const body = {
            PlaceOrderRequest: {
              orderType: 'EQ',
              clientOrderId: `bot${Date.now().toString().slice(-8)}`,
              PreviewIds: [{ previewId }],
              Order: [
                {
                  allOrNone: 'false',
                  priceType: 'MARKET',
                  orderTerm: 'GOOD_FOR_DAY',
                  marketSession: 'REGULAR',
                  stopPrice: '',
                  limitPrice: '',
                  Instrument: [
                    {
                      Product: { securityType: 'EQ', symbol: order.symbol },
                      orderAction: order.side.toUpperCase(),
                      quantity: String(qty)
                    }
                  ]
                }
              ]
            }
          };
          const resp = await this.client.signedFetch(url, 'POST', {
            body: JSON.stringify(body),
            contentType: 'application/json'
          });
          const text = await resp.text();
          if (!resp.ok) {
            throw new Error(`place order failed ${resp.status}: ${text.slice(0, 400)}`);
          }
          const parsed = JSON.parse(text);
          const orderId =
            parsed?.PlaceOrderResponse?.orderId ??
            parsed?.PlaceOrderResponse?.OrderIds?.[0]?.orderId ??
            parsed?.PlaceOrderResponse?.orderIds?.[0]?.orderId ??
            `live-${order.symbol}-${Date.now()}`;
          return { ...preview, orderId, raw: parsed };
        };

        try {
          return await attemptPlace(qtyValue);
        } catch (errPlace) {
          throw errPlace;
        }
      }
      return this.delegate.placeOrder(order, asOf);
    } catch (err) {
      console.warn(`E*TRADE place fallback to stub: ${(err as Error).message}`);
      if (this.hardFail) throw err;
      return this.delegate.placeOrder(order, asOf);
    }
  }

  async getFills(orderIds: string[], asOf: string): Promise<Fill[]> {
    try {
      if (process.env.USE_ETRADE_ORDERS === 'true') {
        const accountKey = await this.getAccountIdKey();
        if (!accountKey) throw new Error('No accountIdKey for fills fetch');
        const fills: Fill[] = [];
        for (const id of orderIds) {
          const url = ORDER_STATUS_URL(this.env, accountKey, id);
          const resp = await this.client.signedFetch(url, 'GET');
          const text = await resp.text();
          if (!resp.ok) throw new Error(`order status ${resp.status}: ${text.slice(0, 400)}`);
          const parsed: any = JSON.parse(text);
          const execs = extractExecutions(parsed, asOf);
          for (const ex of execs) {
            fills.push({
              orderId: String(id),
              symbol: ex.symbol,
              side: ex.side,
              quantity: ex.quantity,
              price: ex.price,
              notional: ex.quantity * ex.price,
              timestamp: ex.time || new Date(asOf).toISOString()
            });
          }
        }
        // If we got no executions, return explicit placeholder so caller can see status.
        if (!fills.length) {
          return orderIds.map((id) => ({
            orderId: String(id),
            symbol: 'UNK',
            side: 'BUY',
            quantity: 0,
            price: 0,
            notional: 0,
            timestamp: new Date(asOf).toISOString()
          }));
        }
        return fills;
      }
      return this.delegate.getFills(orderIds, asOf);
    } catch (err) {
      console.warn(`E*TRADE fills fetch error: ${(err as Error).message}`);
      if (this.hardFail) throw err;
      return this.delegate.getFills(orderIds, asOf);
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    // Best effort; fallback to no-op
    return this.delegate.cancelOrder(orderId);
  }
}
