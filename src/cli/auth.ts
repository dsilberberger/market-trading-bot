import 'dotenv/config';
import { getStatus, connectStart, renewIfPossible, connectFinish } from '../broker/etrade/authService';

const action = process.argv[2] || 'status';
const arg = process.argv[3];

const run = async () => {
  if (action === 'status') {
    console.log(JSON.stringify(getStatus(), null, 2));
    return;
  }
  if (action === 'connect') {
    if (arg) {
      const status = await connectFinish(arg);
      console.log(JSON.stringify(status, null, 2));
    } else {
      const { authorizeUrl, oauthToken } = await connectStart();
      console.log(`Request token: ${oauthToken}`);
      console.log(`Authorize URL: ${authorizeUrl}`);
      console.log('After authorizing, run: npm run auth:connect -- <verifier>');
    }
    return;
  }
  if (action === 'renew') {
    const res = await renewIfPossible();
    console.log(JSON.stringify(res.status, null, 2));
    return;
  }
  throw new Error(`Unknown auth action: ${action}`);
};

run().catch((err) => {
  console.error(`auth:${action} failed`, err);
  process.exitCode = 1;
});
