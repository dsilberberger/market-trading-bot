import { FredClient } from './fredClient';
import { FredClientStub } from './fredClient.stub';

export const getFredClient = () => {
  if (process.env.FRED_API_KEY) {
    return new FredClient(process.env.FRED_API_KEY);
  }
  return new FredClientStub();
};

export { FredClient, FredClientStub };
