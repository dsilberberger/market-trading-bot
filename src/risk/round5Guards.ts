import { ContextMeta, LLMContextPacket } from '../core/types';

export const assertRound5Input = (ctx: LLMContextPacket, meta: ContextMeta) => {
  if (!meta || meta.stage !== 'ROUND_4') {
    throw new Error('Round 5 must be invoked with Round 4 outputs only (invalid stage)');
  }
  if (!meta.lineage?.round4Hash) {
    throw new Error('Missing Round 4 lineage hash — cannot verify decision provenance');
  }
  if (meta.payloadContains?.rawMarketData) {
    throw new Error('Round 5 context must not contain raw market data');
  }
};
