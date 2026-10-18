// 環境用の key を発行し、環境変数に入れる値と PATHS_JSON に入れるハッシュ値を表示する。
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/lib.js';

const key = `k_${randomBytes(24).toString('base64url')}`;
console.log(`UPSTREAM_KEY (環境変数に入れる): ${key}`);
console.log(`key_sha256  (PATHS_JSON に入れる): ${await sha256Hex(key)}`);
