import { getBroker } from "./src/broker/broker";
import { getMarketDataProvider } from "./src/data/marketData";
(async () => {
  try {
    const cfg = require("./src/config/default.json");
    const md = getMarketDataProvider("live" as any);
    const broker = getBroker(cfg as any, md as any);
    const asOf = new Date().toISOString();
    const s = await broker.getPortfolioState(asOf);
    console.log(JSON.stringify({
      asOf,
      cashAvailableForInvestment: s.cashAvailableForInvestment,
      cash: s.cash,
      equity: s.equity,
      positions: (s.positions || []).map((p: any) => ({
        sym: p.symbol,
        qty: p.quantity,
        price: p.price,
        mark: p.mark,
        mv: (p.quantity || 0) * (p.mark || p.price || 0)
      }))
    }, null, 2));
  } catch (e: any) {
    console.error("ERR", e?.message || e);
  }
})();
