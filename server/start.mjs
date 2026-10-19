import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root,'.env'))) process.loadEnvFile(resolve(root,'.env'));
const runtime = resolve(root,'.runtime');
await mkdir(runtime,{recursive:true,mode:0o700});
const secretFile = resolve(runtime,'local-secrets.json');
let secrets;
try { secrets=JSON.parse(await readFile(secretFile,'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets={sessionSecret:randomBytes(48).toString('base64url'),encryptionKey:randomBytes(48).toString('base64url')};
  await writeFile(secretFile,JSON.stringify(secrets),{mode:0o600,flag:'wx'});
}
const host=process.env.HOST||'127.0.0.1'; const port=Number(process.env.PORT||4317);
const loopback=['127.0.0.1','localhost','::1'].includes(host);
// A loopback listener behind a public tunnel (PUBLIC_BASE_URL set) is internet-reachable too:
// do not fall back to the key file that sits beside the database it encrypts.
const exposed=!loopback || Boolean(process.env.PUBLIC_BASE_URL);
if (exposed && (!process.env.AVAFEM_SESSION_SECRET || !process.env.AVAFEM_CREDENTIAL_ENCRYPTION_KEY || !process.env.AVAFEM_ADMIN_TOKEN))
  throw new Error('A network listener or PUBLIC_BASE_URL tunnel requires explicit session/encryption/admin secrets from the environment or a secret manager. Use plain loopback for local development.');
if (exposed && Buffer.byteLength(process.env.AVAFEM_CREDENTIAL_ENCRYPTION_KEY)<32)
  throw new Error('AVAFEM_CREDENTIAL_ENCRYPTION_KEY must be at least 32 bytes of random data.');
const app=await createApp({
  dataDir:resolve(runtime,'postgres'), connectionString:process.env.DATABASE_URL,
  config:{mode:process.env.AVAFEM_MODE||'sandbox',host,port,
    allowLocalBootstrap:loopback && !process.env.PUBLIC_BASE_URL && process.env.AVAFEM_ALLOW_LOCAL_BOOTSTRAP!=='false',
    sessionSecret:process.env.AVAFEM_SESSION_SECRET||secrets.sessionSecret,
    encryptionKey:process.env.AVAFEM_CREDENTIAL_ENCRYPTION_KEY||secrets.encryptionKey,
    adminToken:process.env.AVAFEM_ADMIN_TOKEN,publicBaseUrl:process.env.PUBLIC_BASE_URL,
  },logger:{level:'warn',
    serializers:{req:request=>({method:request.method,path:String(request.url || '').split('?')[0]})},
    redact:['req.headers.authorization','req.headers.cookie','req.body','res.headers','err'],
  },
});
await app.listen({host,port});
console.log(`Avafem Brand Connect is running at http://${host}:${port}`);
console.log('Sandbox only. Local credentials and PostgreSQL data are stored in the ignored .runtime directory.');
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{await app.close();process.exit(0);});
