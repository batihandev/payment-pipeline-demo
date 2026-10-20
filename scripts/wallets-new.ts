import { parseEnv } from 'node:util';
import { chmod, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

export async function createWallets(
  path: string,
): Promise<{ BUYER: string; SHOP: string }> {
  const lockPath = `${path}.wallets.lock`;
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = `${path}.wallets.tmp`;
  try {
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      contents = '';
    }
    const set = (name: string, value: string) => {
      const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=.*$`, 'm');
      contents = pattern.test(contents)
        ? contents.replace(pattern, `${name}=${value}`)
        : `${contents}${contents.endsWith('\n') || !contents ? '' : '\n'}${name}=${value}\n`;
    };
    const addresses = {} as { BUYER: string; SHOP: string };
    for (const name of ['BUYER', 'SHOP'] as const) {
      const existing = parseEnv(contents)[`${name}_PRIVATE_KEY`];
      if (existing && !/^0x[0-9a-fA-F]{64}$/.test(existing))
        throw new Error(`Invalid ${name}_PRIVATE_KEY`);
      const key = (existing || generatePrivateKey()) as Hex;
      addresses[name] = privateKeyToAccount(key).address;
      if (!existing) set(`${name}_PRIVATE_KEY`, key);
      set(`${name}_ADDRESS`, addresses[name]);
    }
    await writeFile(temporary, contents, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    return addresses;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (require.main === module) {
  createWallets('.env')
    .then((addresses) => {
      console.log(`Buyer: ${addresses.BUYER}\nShop: ${addresses.SHOP}`);
    })
    .catch(() => {
      console.error(
        'Could not create wallets. Check wallet settings and file permissions.',
      );
      process.exitCode = 1;
    });
}
