// Server-managed key material, generated on first start and kept on the data volume (mode 0600).
// - Ed25519 key pair: signs proof dossiers; the public key is embedded so anyone can verify offline.
// - Symmetric key: encrypts webhook secrets at rest (they must be recoverable to check HMACs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function loadKeys(dataDir) {
  const dir = path.join(dataDir, 'keys');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pemFile = path.join(dir, 'dossier-ed25519.pem'), symFile = path.join(dir, 'secretbox.key');
  if (!fs.existsSync(pemFile)) fs.writeFileSync(pemFile, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  if (!fs.existsSync(symFile)) fs.writeFileSync(symFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const privateKey = crypto.createPrivateKey(fs.readFileSync(pemFile));
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const sym = process.env.SERVER_SECRET ? crypto.createHash('sha256').update(process.env.SERVER_SECRET).digest() : Buffer.from(fs.readFileSync(symFile, 'utf8').trim(), 'hex');
  return {
    publicKey, keyId: crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16),
    sign: (text) => crypto.sign(null, Buffer.from(text), privateKey).toString('base64'),
    encrypt(text) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', sym, iv);
      return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
    },
    decrypt(blob) {
      const b = Buffer.from(blob, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', sym, b.subarray(0, 12));
      d.setAuthTag(b.subarray(b.length - 16));
      return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8');
    },
  };
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Offline verification of a dossier document. Needs nothing but the document itself. */
export function verifyDossier(doc) {
  const problems = [];
  try {
    const { payload, manifest } = doc;
    const hash = sha256(canonical(payload));
    if (hash !== manifest.payloadSha256) problems.push('payload hash does not match the manifest (content was altered)');
    for (const [k, h] of Object.entries(manifest.sectionSha256 || {})) if (sha256(canonical(payload[k] ?? null)) !== h) problems.push(`section "${k}" was altered`);
    const ok = crypto.verify(null, Buffer.from(manifest.payloadSha256), crypto.createPublicKey(manifest.publicKey), Buffer.from(manifest.signature, 'base64'));
    if (!ok) problems.push('signature is not valid for this manifest');
    if (sha256(manifest.publicKey).slice(0, 16) !== manifest.keyId) problems.push('key id does not match the embedded public key');
  } catch (e) { problems.push(`malformed dossier: ${e.message}`); }
  return { valid: problems.length === 0, problems };
}
