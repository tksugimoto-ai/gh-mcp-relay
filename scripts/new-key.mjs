// 環境用の key を発行する。署名用の鍵 KEY_SECRET を持っている人だけが発行できる。
//   KEY_SECRET=... npm run new-key -- tksugimoto/pocket-ssh-agent [owner/repo ...] [--expires 2027-04-01]
import { createKey } from '../src/lib.js';

const args = process.argv.slice(2);
const i = args.indexOf('--expires');
const expires = i >= 0 ? args.splice(i, 2)[1] : undefined;
const secret = process.env.KEY_SECRET;
if (!secret || args.length === 0) {
  console.error('使い方: KEY_SECRET=... npm run new-key -- <owner/repo> [owner/repo ...] [--expires YYYY-MM-DD]');
  process.exit(1);
}
console.log(await createKey(secret, { repos: args, expires }));
