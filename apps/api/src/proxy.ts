// Trust only the nearest proxy, so the client address is the entry it appended
// and a forged leftmost X-Forwarded-For value is ignored.
export const proxyTrust = (
  enabled: boolean,
): false | ((address: string, hop: number) => boolean) =>
  enabled ? (_address, hop) => hop < 1 : false;
